import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	correctedReplayFrame,
	loadReplayFixture,
	makeReplayCases,
	originalReplayFrames,
	replayEvidence,
	scoreReplayFrame,
} from "../evals/context-window/handoff-replay.ts";

describe("evidence-backed handoff replay grading", () => {
	it("prepares matched repetitions without injecting reference handoffs or grader annotations", () => {
		const fixture = loadReplayFixture();
		const cases = makeReplayCases(fixture);
		expect(cases).toHaveLength(4);
		for (const sample of cases) {
			expect(sample.initialBrief).toBe(fixture.instruction.text);
			expect(sample.observations).toEqual(fixture.windows.map((window) => JSON.stringify(window.records)));
			for (const handoff of fixture.handoffs) expect(JSON.stringify(sample)).not.toContain(handoff.text);
			expect(JSON.stringify(sample)).not.toContain('"claims":');
		}
	});
	it("pins exact excerpts and keeps long chronological tool observations separate from grading", () => {
		const fixture = loadReplayFixture();
		for (const record of [
			fixture.instruction,
			...fixture.handoffs,
			...fixture.windows.flatMap((window) => window.records),
		]) {
			expect(createHash("sha256").update(record.text).digest("hex")).toBe(record.sha256);
		}
		expect(fixture.windows.map((window) => window.cut)).toEqual([1, 2, 3]);
		expect(Buffer.byteLength(JSON.stringify(fixture.windows[1].records))).toBeGreaterThan(60000);
		for (const evidence of replayEvidence) {
			const record = fixture.windows[evidence.cut - 1].records.find((item) => item.entryId === evidence.id);
			expect(record).toBeDefined();
			expect(JSON.parse(record!.text).return_code).toBe(evidence.outcome === "failed" ? 1 : 0);
		}
	});
	it("flags the actual third-handoff omission despite the genuine full-suite pass", () => {
		const frames = originalReplayFrames(loadReplayFixture());
		expect(frames.map((frame) => scoreReplayFrame(frame))).toEqual([[], [], ["safe-upsert:missing"]]);
	});
	it("accepts the minimal corrected handoff with only the covered requirements resolved", () => {
		expect(scoreReplayFrame(correctedReplayFrame())).toEqual([]);
	});
	it("rejects a stale annotation when the pending sentence is deleted", () => {
		const frame = correctedReplayFrame();
		frame.brief = frame.brief.replace(frame.claims[0].quote!, "");
		expect(scoreReplayFrame(frame)).toEqual(["safe-upsert:quote-not-found"]);
	});
	it("does not treat retaining a feature name or unrelated passing evidence as verification", () => {
		const frame = correctedReplayFrame();
		frame.brief =
			"Verified safe upsert (1879905a). Verified checkpoint checks (a0462464); docs command examples (14c1c74b). Next: final review.";
		frame.claims[0] = {
			requirement: "safe-upsert",
			status: "verified",
			quote: "Verified safe upsert (1879905a).",
			evidenceId: "1879905a",
		};
		expect(scoreReplayFrame(frame)).toEqual(["safe-upsert:unsupported-verified"]);
	});
	it("rejects failed, unknown and not-yet-observed evidence", () => {
		for (const id of ["2598314a", "unknown"]) {
			const frame = correctedReplayFrame();
			frame.claims[2].evidenceId = id;
			expect(scoreReplayFrame(frame)).toContain("docs-command-examples:unsupported-verified");
		}
		const early = correctedReplayFrame();
		early.cut = 2;
		expect(scoreReplayFrame(early)).toEqual([
			"checkpoint-checks:unsupported-verified",
			"docs-command-examples:unsupported-verified",
		]);
	});
	it("leaves other requirements pending when only one targeted check passes", () => {
		const frame = originalReplayFrames(loadReplayFixture())[1];
		frame.brief =
			"Modified but unverified: safe upsert and docs command examples. Verified checkpoint checks (synthetic-checkpoint). Next: validate remaining work.";
		frame.claims[0].quote = "Modified but unverified: safe upsert and docs command examples.";
		frame.claims[2].quote = "Modified but unverified: safe upsert and docs command examples.";
		frame.claims[1] = {
			requirement: "checkpoint-checks",
			status: "verified",
			quote: "Verified checkpoint checks (synthetic-checkpoint).",
			evidenceId: "synthetic-checkpoint",
		};
		expect(
			scoreReplayFrame(frame, [
				...replayEvidence,
				{ id: "synthetic-checkpoint", cut: 2, outcome: "passed", covers: ["checkpoint-checks"] },
			]),
		).toEqual([]);
	});
	it("accepts explicit user cancellation, rejects false verification and obsolete pending work", () => {
		const frame = correctedReplayFrame();
		const evidence = [
			...replayEvidence,
			{ id: "synthetic-user-change", cut: 3, outcome: "user-removed" as const, covers: ["safe-upsert" as const] },
		];
		expect(scoreReplayFrame(frame, evidence)).toEqual(["safe-upsert:obsolete-pending"]);
		frame.brief =
			"User removed safe upsert from scope (synthetic-user-change). Verified checkpoint checks (a0462464); docs command examples (14c1c74b). Next: final review.";
		frame.claims[0] = {
			requirement: "safe-upsert",
			status: "removed",
			quote: "User removed safe upsert from scope (synthetic-user-change).",
			evidenceId: "synthetic-user-change",
		};
		expect(scoreReplayFrame(frame, evidence)).toEqual([]);
		frame.claims[0].status = "verified";
		expect(scoreReplayFrame(frame, evidence)).toEqual(["safe-upsert:unsupported-verified"]);
	});
	it("never hides an earlier omission when a later handoff restores the item", () => {
		const frames = originalReplayFrames(loadReplayFixture());
		frames[1].brief = frames[1].brief.replace("safe upsert, ", "");
		frames[1].claims[0] = { requirement: "safe-upsert", status: "missing" };
		frames[2] = correctedReplayFrame();
		expect(frames.flatMap((frame) => scoreReplayFrame(frame))).toEqual(["safe-upsert:missing"]);
	});
	it("rejects incomplete, duplicate or ambiguous annotations instead of silently passing them", () => {
		const frame = correctedReplayFrame();
		frame.claims[0].status = "ambiguous";
		expect(scoreReplayFrame(frame)).toEqual(["safe-upsert:ambiguous"]);
		frame.claims.shift();
		expect(scoreReplayFrame(frame)).toEqual(["safe-upsert:annotation-count"]);
		frame.claims.push(frame.claims[0]);
		expect(scoreReplayFrame(frame)).toEqual(["safe-upsert:annotation-count", "checkpoint-checks:annotation-count"]);
	});
	it("does not accept an old passing result after a newer targeted failure", () => {
		const frame = correctedReplayFrame();
		frame.cut = 4;
		expect(
			scoreReplayFrame(frame, [
				...replayEvidence,
				{ id: "synthetic-later-failure", cut: 4, outcome: "failed", covers: ["checkpoint-checks"] },
			]),
		).toEqual(["checkpoint-checks:superseded-evidence"]);
	});
});
