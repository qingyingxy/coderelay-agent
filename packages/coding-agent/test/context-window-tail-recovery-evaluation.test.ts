import { describe, expect, it } from "vitest";
import { runContextWindowTailRecoveryEvaluation } from "../evals/context-window/evaluate-tail-recovery.ts";

describe("context-window JSONL tail recovery evaluation", () => {
	it("recovers across partial Snapshot, boundary, and new-window continuation records", async () => {
		const report = await runContextWindowTailRecoveryEvaluation();

		expect(report).toMatchObject({
			provider: "faux",
			deterministic: true,
			serialExecution: true,
			paidTokens: 0,
			passed: true,
			passedScenarios: 3,
			totalScenarios: 3,
		});
		expect(report.results.map(({ id }) => id)).toEqual([
			"partial-snapshot",
			"partial-context-window",
			"partial-new-window-continuation",
		]);
		expect(report.results.every(({ checks }) => checks.length === 7 && checks.every(({ passed }) => passed))).toBe(
			true,
		);
	}, 30_000);
});
