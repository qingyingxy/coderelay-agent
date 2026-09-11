import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { captureEvaluationBaseline } from "../../evals/cost-matrix/baseline.ts";
import { completeDelivery } from "../../evals/cost-matrix/delivery-cycle.ts";
import { liveBoundaryExtension, liveToolViolation } from "../../evals/cost-matrix/tool-boundary.ts";
import { createHarness, getAssistantTexts } from "./harness.ts";

const adapters = JSON.parse(
	readFileSync(new URL("../../evals/cost-matrix/adapters.json", import.meta.url), "utf8"),
) as Record<string, { writeRoots: string[] }>;

it("captures business baseline without following the protected dependency junction", () => {
	const workspace = mkdtempSync(join(tmpdir(), "matrix-baseline-test-"));
	const dependencies = mkdtempSync(join(tmpdir(), "matrix-dependencies-"));
	try {
		mkdirSync(join(workspace, "business/desktop/src"), { recursive: true });
		writeFileSync(join(workspace, "business/desktop/src/store.ts"), "original");
		writeFileSync(join(dependencies, "dependency.txt"), "protected");
		symlinkSync(dependencies, join(workspace, "business/desktop/node_modules"), "junction");
		const policy = { workspace, dependencyRoots: [dependencies], writeRoots: ["business"], writable: true };
		const baseline = captureEvaluationBaseline(workspace, "offline", ["business"], "business/desktop");
		expect(baseline.cwd).toBe(workspace);
		expect(baseline.files).toEqual([{ path: "business/desktop/src/store.ts", content: "original" }]);
		expect(baseline.directories).toContain("business/desktop/src");
		expect(liveToolViolation(policy, "write", { path: "business/desktop/node_modules/dependency.txt" })).toBeTruthy();
		expect(readFileSync(join(workspace, "business/desktop/node_modules/dependency.txt"), "utf8")).toBe("protected");
		symlinkSync(dependencies, join(workspace, "business/escape"), "junction");
		expect(() => captureEvaluationBaseline(workspace, "offline", ["business"], "business/desktop")).toThrow(
			"symbolic link",
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(dependencies, { recursive: true, force: true });
	}
});

for (const [id, adapter] of Object.entries(adapters)) {
	it(`${id}: real tool dispatch blocks escapes and read-only writes, then passes evidence through one repair`, async () => {
		const workspace = mkdtempSync(join(tmpdir(), "matrix-boundary-"));
		const policy = { workspace, dependencyRoots: [], writeRoots: adapter.writeRoots, writable: true };
		const target = join(workspace, adapter.writeRoots[0], "offline-fixture.txt");
		mkdirSync(dirname(target), { recursive: true });
		mkdirSync(join(workspace, ".acceptance"));
		writeFileSync(target, "unfinished");
		writeFileSync(join(workspace, ".acceptance/common.txt"), "fixed acceptance");
		const harness = await createHarness({
			initialActiveToolNames: ["read", "write", "bash"],
			extensionFactories: [liveBoundaryExtension(policy)],
		});
		const reviewHarness = await createHarness({
			initialActiveToolNames: ["read", "write"],
			extensionFactories: [liveBoundaryExtension({ ...policy, writable: false })],
		});
		try {
			symlinkSync(harness.tempDir, join(dirname(target), "escape"), "junction");
			for (const path of ["../other/answer.txt", join(dirname(target), "escape/answer.txt")]) {
				expect(liveToolViolation(policy, "read", { path })).toBeTruthy();
			}
			for (const path of [
				".acceptance/common.txt",
				"frontend/e2e/case.ts",
				"frontend/package.json",
				`${adapter.writeRoots[0]}/tests/case.py`,
			]) {
				expect(liveToolViolation(policy, "write", { path })).toBeTruthy();
			}
			if (id === "live-state-pagination")
				expect(
					liveToolViolation(policy, "write", { path: "Tools/LiveCommentBridge/dashboard_server.py" }),
				).toBeUndefined();
			const trace: string[] = [];
			const result = await completeDelivery({
				async verify(attempt) {
					trace.push(`verify-${attempt}`);
					return {
						passed: readFileSync(target, "utf8") === "fixed",
						infrastructureComplete: true,
						log: `HOST-EVIDENCE-${attempt}`,
						command: `verify-task ${id}`,
						exitCode: attempt ? 0 : 1,
					};
				},
				async review(evidence, attempt) {
					trace.push(`review-${attempt}`);
					reviewHarness.setResponses([
						fauxAssistantMessage(fauxToolCall("write", { path: target, content: "reviewer must not write" }), {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage(evidence.passed ? "passed" : "failed"),
					]);
					await reviewHarness.session.prompt(evidence.log);
					expect(JSON.stringify(reviewHarness.session.messages)).toContain(evidence.log);
					expect(JSON.stringify(reviewHarness.session.messages)).toContain("Evaluation boundary");
					return {
						status: getAssistantTexts(reviewHarness).at(-1) === "passed" ? "passed" : "failed",
						summary: evidence.log,
						failureKind: "finding",
						evidenceRefs: [],
						risks: [],
						unfinishedItems: [],
					};
				},
				async repair(evidence, review) {
					trace.push("repair");
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("read", { path: join(workspace, ".acceptance/common.txt") }), {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage(
							fauxToolCall("write", { path: join(workspace, ".acceptance/common.txt"), content: "tampered" }),
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage(fauxToolCall("bash", { command: "echo disallowed" }), { stopReason: "toolUse" }),
						fauxAssistantMessage(fauxToolCall("write", { path: target, content: "fixed" }), {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage("Done"),
					]);
					await harness.session.prompt(`${evidence.log}\n${review.summary}`);
				},
			});
			expect(result).toMatchObject({ passed: true, repairCount: 1 });
			expect(trace).toEqual(["verify-0", "review-0", "repair", "verify-1", "review-1"]);
			expect(readFileSync(join(workspace, ".acceptance/common.txt"), "utf8")).toBe("fixed acceptance");
			expect(readFileSync(target, "utf8")).toBe("fixed");
		} finally {
			harness.cleanup();
			reviewHarness.cleanup();
			rmSync(workspace, { recursive: true, force: true });
		}
	});
}

it("does not repair infrastructure failures or exceed one repair for repeated failures", async () => {
	for (const infrastructureComplete of [false, true]) {
		let reviews = 0;
		let repairs = 0;
		const result = await completeDelivery({
			async verify() {
				return { passed: false, infrastructureComplete, log: "failure", command: "offline", exitCode: 1 };
			},
			async review() {
				reviews++;
				return {
					status: "failed",
					failureKind: "finding",
					summary: "real failure",
					evidenceRefs: [],
					risks: [],
					unfinishedItems: [],
				};
			},
			async repair() {
				repairs++;
			},
		});
		expect(result.passed).toBe(false);
		expect(reviews).toBe(infrastructureComplete ? 2 : 0);
		expect(repairs).toBe(infrastructureComplete ? 1 : 0);
	}
});
