import { readFileSync } from "node:fs";
import type { MicroCase } from "./handoff-micro.ts";

export interface ReplayFixture {
	provenance: { report: string; source: string; sourceSha256: string; transformation: string };
	instruction: { entryId: string; text: string; sha256: string };
	handoffs: { entryId: string; callId: string; text: string; sha256: string }[];
	windows: { cut: number; records: { entryId: string; command: string; text: string; sha256: string }[] }[];
}

export function loadReplayFixture(): ReplayFixture {
	return JSON.parse(readFileSync(new URL("../../test/fixtures/handoff-replay/cw18.14.json", import.meta.url), "utf8")) as ReplayFixture;
}

export function makeReplayCases(fixture: ReplayFixture = loadReplayFixture()): MicroCase[] {
	return Array.from({ length: 4 }, (_, index) => ({
		id: `recorded-replay-${index + 1}`,
		feature: "safe-upsert; checkpoint checks; docs command examples",
		scenario: "pending",
		initialBrief: fixture.instruction.text,
		observations: fixture.windows.map((window) => JSON.stringify(window.records)),
	}));
}

export const replayRequirements = ["safe-upsert", "checkpoint-checks", "docs-command-examples"] as const;
export type ReplayRequirement = typeof replayRequirements[number];
export interface ReplayEvidence {
	id: string;
	cut: number;
	outcome: "passed" | "failed" | "user-removed";
	covers: ReplayRequirement[];
}
export interface ReplayClaim {
	requirement: ReplayRequirement;
	status: "pending" | "verified" | "removed" | "missing" | "ambiguous";
	quote?: string;
	evidenceId?: string;
}
export interface ReplayFrame {
	cut: number;
	brief: string;
	claims: ReplayClaim[];
}

// These coverage labels are manually audited evaluation data, never sent in a Seed.
export const replayEvidence: ReplayEvidence[] = [
	{ id: "2959ba6b", cut: 2, outcome: "passed", covers: [] },
	{ id: "2598314a", cut: 3, outcome: "failed", covers: ["docs-command-examples"] },
	{ id: "14c1c74b", cut: 3, outcome: "passed", covers: ["checkpoint-checks", "docs-command-examples"] },
	{ id: "a0462464", cut: 3, outcome: "passed", covers: ["checkpoint-checks"] },
	{ id: "1879905a", cut: 3, outcome: "passed", covers: ["checkpoint-checks", "docs-command-examples"] },
];

/** Checks reviewed annotations and evidence attribution; does not parse arbitrary prose. */
export function scoreReplayFrame(frame: ReplayFrame, evidence: readonly ReplayEvidence[] = replayEvidence): string[] {
	const failures: string[] = [];
	for (const requirement of replayRequirements) {
		const claims = frame.claims.filter((claim) => claim.requirement === requirement);
		if (claims.length !== 1) { failures.push(`${requirement}:annotation-count`); continue; }
		const claim = claims[0];
		if (claim.status === "missing" || claim.status === "ambiguous") { failures.push(`${requirement}:${claim.status}`); continue; }
		if (!claim.quote?.trim() || !frame.brief.includes(claim.quote)) { failures.push(`${requirement}:quote-not-found`); continue; }
		const available = evidence.filter((item) => item.cut <= frame.cut && item.covers.includes(requirement));
		const latest = available.at(-1);
		if (claim.status === "pending") {
			if (latest?.outcome === "passed" || latest?.outcome === "user-removed") failures.push(`${requirement}:obsolete-pending`);
			continue;
		}
		const cited = available.find((item) => item.id === claim.evidenceId);
		if (!cited || cited.outcome !== (claim.status === "verified" ? "passed" : "user-removed")) {
			failures.push(`${requirement}:unsupported-${claim.status}`);
		} else if (latest && latest.outcome !== cited.outcome) {
			failures.push(`${requirement}:superseded-evidence`);
		}
	}
	return failures;
}

export function originalReplayFrames(fixture: ReplayFixture): ReplayFrame[] {
	return fixture.handoffs.map((handoff, index) => ({
		cut: index + 1,
		brief: handoff.text,
		claims: index < 2
			? replayRequirements.map((requirement) => ({ requirement, status: "pending", quote: index === 0 ? "Unverified full task." : "Need add/run focused tests before submitting." }))
			: [
				{ requirement: "safe-upsert", status: "missing" },
				{ requirement: "checkpoint-checks", status: "verified", quote: "focused suite passed (tests/test_safe_import.py, CLI insert/bulk, docs).", evidenceId: "a0462464" },
				{ requirement: "docs-command-examples", status: "verified", quote: "focused suite passed (tests/test_safe_import.py, CLI insert/bulk, docs).", evidenceId: "14c1c74b" },
			],
	}));
}

export function correctedReplayFrame(): ReplayFrame {
	return {
		cut: 3,
		brief: "Modified but unverified: safe upsert transaction behavior. Add/run safe_bulk_upsert and CLI upsert checks before submission. Verified: checkpoint checks (a0462464); docs command examples (14c1c74b). Existing full suite: 1060 passed, 16 skipped (1879905a). Next: verify upsert, then final diff review.",
		claims: [
			{ requirement: "safe-upsert", status: "pending", quote: "Modified but unverified: safe upsert transaction behavior." },
			{ requirement: "checkpoint-checks", status: "verified", quote: "checkpoint checks (a0462464)", evidenceId: "a0462464" },
			{ requirement: "docs-command-examples", status: "verified", quote: "docs command examples (14c1c74b)", evidenceId: "14c1c74b" },
		],
	};
}
