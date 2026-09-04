import { describe, expect, it } from "vitest";
import { runContextWindowProcessRecoveryEvaluation } from "../evals/context-window/evaluate-process-recovery.ts";

describe("context-window OS-process recovery evaluation", () => {
	it("recovers the old or new window according to the last durable boundary", async () => {
		const report = await runContextWindowProcessRecoveryEvaluation();

		expect(report).toMatchObject({
			provider: "faux",
			deterministic: true,
			serialExecution: true,
			paidTokens: 0,
			passed: true,
			passedScenarios: 2,
			totalScenarios: 2,
		});
		expect(report.results.map(({ id, exitCode }) => ({ id, exitCode }))).toEqual([
			{ id: "after-snapshot", exitCode: 86 },
			{ id: "after-boundary", exitCode: 87 },
		]);
		expect(report.results.every(({ checks }) => checks.length >= 7 && checks.every(({ passed }) => passed))).toBe(
			true,
		);
	}, 30_000);
});
