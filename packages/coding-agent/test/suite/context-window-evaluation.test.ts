import { describe, expect, it } from "vitest";
import { runContextWindowEvaluation } from "../../evals/context-window/evaluate.ts";

describe("context window Faux Provider evaluation", () => {
	it("passes the deterministic A/B/C/D mechanism matrix", async () => {
		const report = await runContextWindowEvaluation();
		const failures = report.results
			.filter(({ passed }) => !passed)
			.map(({ group, error, checks }) => ({
				group,
				error,
				failedChecks: checks.filter(({ passed }) => !passed),
			}));

		expect(report, JSON.stringify(failures, null, 2)).toMatchObject({
			schemaVersion: 1,
			provider: "faux",
			deterministic: true,
			passed: true,
			passedCases: 4,
			totalCases: 4,
		});
		expect(report.results.map(({ group }) => group)).toEqual(["A", "B", "C", "D"]);
		expect(report.results.every(({ failureArtifacts }) => failureArtifacts.length === 0)).toBe(true);

		const [summary, windowed, workflow, hybrid] = report.results;
		expect(summary.metrics).toMatchObject({ hardCuts: 0, summaries: 1, historyQueries: 0, noteOperations: 0 });
		expect(windowed.metrics).toMatchObject({ hardCuts: 1, summaries: 0, historyQueries: 1, noteOperations: 1 });
		expect(workflow.metrics).toMatchObject({ hardCuts: 1, summaries: 0, historyQueries: 1, noteOperations: 1 });
		expect(hybrid.metrics).toMatchObject({ hardCuts: 1, summaries: 1, historyQueries: 1, noteOperations: 1 });
	});
});
