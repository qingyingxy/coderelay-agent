import { describe, expect, it } from "vitest";
import {
	calculateEstimatedCost,
	evaluateExpectedOutput,
	extractJsonObject,
	parseRealTaskSet,
	type RealContextWindowTask,
} from "../evals/context-window/evaluate-real.ts";

const TASK: RealContextWindowTask = {
	id: "task-1",
	description: "test",
	durableFacts: ["Keep alpha."],
	lookup: { recordId: "record-1", value: { digest: "abc" } },
	expected: { task_id: "task-1", digest: "abc" },
	forbiddenTerms: ["obsolete"],
	distractorRecords: 0,
};

describe("real context-window evaluation", () => {
	it("calculates official cost without double-counting reasoning tokens", () => {
		expect(
			calculateEstimatedCost(
				{
					input: 1_000_000,
					output: 1_000_000,
					reasoning: 800_000,
					cacheRead: 1_000_000,
					cacheWrite: 1_000_000,
					total: 4_000_000,
				},
				{ input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
			),
		).toBe(16.7);
	});

	it("accepts strict JSON and a single JSON fence", () => {
		expect(extractJsonObject('{"task_id":"task-1"}')).toEqual({ task_id: "task-1" });
		expect(extractJsonObject('```json\n{"task_id":"task-1"}\n```')).toEqual({ task_id: "task-1" });
		expect(extractJsonObject('result: {"task_id":"task-1"}')).toBeNull();
	});

	it("grades exact keys, exact values, and forbidden terms deterministically", () => {
		const passing = evaluateExpectedOutput('{"task_id":"task-1","digest":"abc"}', TASK);
		expect(passing.checks.every(({ passed }) => passed)).toBe(true);

		const failing = evaluateExpectedOutput('{"task_id":"task-1","digest":"wrong","note":"obsolete"}', TASK);
		expect(failing.checks.filter(({ passed }) => !passed).map(({ id }) => id)).toEqual([
			"exact-keys",
			"value:digest",
			"forbidden:obsolete",
		]);
	});

	it("validates the versioned task set", () => {
		expect(
			parseRealTaskSet({
				schemaVersion: 1,
				id: "fixture",
				tasks: [TASK],
			}),
		).toMatchObject({ id: "fixture", tasks: [{ id: "task-1" }] });
		expect(() => parseRealTaskSet({ schemaVersion: 2, id: "fixture", tasks: [TASK] })).toThrow(
			"schemaVersion must be 1",
		);
	});
});
