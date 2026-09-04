import { describe, expect, it } from "vitest";
import { runContextWindowLifecycleEvaluation } from "../evals/context-window/evaluate-lifecycle.ts";

describe("context-window lifecycle evaluation", () => {
	it("passes multi-window, resume, branching, repair, and overflow scenarios serially", async () => {
		const report = await runContextWindowLifecycleEvaluation();

		expect(report).toMatchObject({
			provider: "faux",
			deterministic: true,
			serialExecution: true,
			passed: true,
			passedScenarios: 5,
			totalScenarios: 5,
		});
		expect(report.results.map(({ id }) => id)).toEqual([
			"multi-window-lineage",
			"resume-from-jsonl",
			"fork-rollback-branch-isolation",
			"attempt-repair-recovery",
			"overflow-hard-cut-retry",
		]);
		expect(report.results.every(({ checks }) => checks.length >= 4 && checks.every(({ passed }) => passed))).toBe(
			true,
		);
	});
});
