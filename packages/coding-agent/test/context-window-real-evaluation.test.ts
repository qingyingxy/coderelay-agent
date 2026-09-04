import { describe, expect, it } from "vitest";
import {
	calculateEstimatedCost,
	evaluateExpectedOutput,
	extractJsonObject,
	parseCliOptions,
	parseRealTaskSet,
	type RealContextWindowTask,
} from "../evals/context-window/evaluate-real.ts";

const TASK: RealContextWindowTask = {
	id: "task-1",
	description: "test",
	durableFacts: ["Keep alpha."],
	lookup: { recordId: "record-1", value: { digest: "abc" } },
	expected: { case_id: "task-1", digest: "abc" },
	forbiddenTerms: ["obsolete"],
	distractorRecords: 0,
};

describe("real context-window evaluation", () => {
	it("parses an explicit positive repetition count", () => {
		expect(parseCliOptions([]).repetitions).toBe(1);
		expect(parseCliOptions(["--repetitions", "3"]).repetitions).toBe(3);
		expect(() => parseCliOptions(["--repetitions", "0"])).toThrow("requires a positive number");
		expect(() => parseCliOptions(["--repetitions", "1.5"])).toThrow("requires a positive integer");
	});

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
		expect(extractJsonObject('{"case_id":"task-1"}')).toEqual({ case_id: "task-1" });
		expect(extractJsonObject('```json\n{"case_id":"task-1"}\n```')).toEqual({ case_id: "task-1" });
		expect(extractJsonObject('result: {"case_id":"task-1"}')).toBeNull();
	});

	it("grades exact keys, exact values, and forbidden terms deterministically", () => {
		const passing = evaluateExpectedOutput('{"case_id":"task-1","digest":"abc"}', TASK);
		expect(passing.checks.every(({ passed }) => passed)).toBe(true);

		const failing = evaluateExpectedOutput('{"case_id":"task-1","digest":"wrong","note":"obsolete"}', TASK);
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
		expect(() =>
			parseRealTaskSet({
				schemaVersion: 1,
				id: "fixture",
				tasks: [{ ...TASK, expected: { digest: "abc" } }],
			}),
		).toThrow("expected.case_id must equal task-1");
		expect(() =>
			parseRealTaskSet({
				schemaVersion: 1,
				id: "fixture",
				tasks: [{ ...TASK, expected: { case_id: "record-1", digest: "abc" } }],
			}),
		).toThrow("expected.case_id must equal task-1");
	});
});
