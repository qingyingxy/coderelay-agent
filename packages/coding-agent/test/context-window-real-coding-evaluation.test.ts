import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	evaluateCodingFinalResponse,
	initializeCodingFixture,
	parseRealCodingCliOptions,
	parseRealCodingTaskSet,
	type RealCodingTask,
	runCodingFixtureVerification,
} from "../evals/context-window/evaluate-real-coding.ts";

const TASK: RealCodingTask = {
	id: "fixture-router",
	description: "fixture",
	durableFacts: ["Keep the fallback."],
	probe: { probeId: "fixture-probe", repairMarker: "omega-41" },
	expectedFinal: { case_id: "fixture-router", status: "passed" },
};

describe("real multi-window coding evaluation", () => {
	it("parses bounded CLI options", () => {
		expect(parseRealCodingCliOptions([])).toMatchObject({ thinking: "medium", maxCostUsd: 3 });
		expect(parseRealCodingCliOptions(["--thinking", "xhigh", "--max-cost", "2.5"])).toMatchObject({
			thinking: "xhigh",
			maxCostUsd: 2.5,
		});
		expect(() => parseRealCodingCliOptions(["--thinking", "max"])).toThrow("--thinking must be one of");
		expect(() => parseRealCodingCliOptions(["--max-output-tokens", "1.5"])).toThrow("positive integer");
	});

	it("validates task identifiers and expected output", () => {
		expect(parseRealCodingTaskSet({ schemaVersion: 1, id: "fixture", tasks: [TASK] })).toMatchObject({
			id: "fixture",
			tasks: [{ id: "fixture-router" }],
		});
		expect(() =>
			parseRealCodingTaskSet({
				schemaVersion: 1,
				id: "fixture",
				tasks: [{ ...TASK, expectedFinal: { case_id: "wrong", status: "passed" } }],
			}),
		).toThrow("expectedFinal.case_id must equal fixture-router");
	});

	it("grades exact final JSON", () => {
		expect(
			evaluateCodingFinalResponse('{"case_id":"fixture-router","status":"passed"}', TASK).every(
				({ passed }) => passed,
			),
		).toBe(true);
		expect(
			evaluateCodingFinalResponse('{"case_id":"fixture-router","status":"failed"}', TASK)
				.filter(({ passed }) => !passed)
				.map(({ id }) => id),
		).toEqual(["final-value:status"]);
	});

	it("requires the exact hidden repair marker after functional checks", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-real-coding-fixture-"));
		try {
			const fixture = initializeCodingFixture(root, TASK);
			const initial = runCodingFixtureVerification(root, "initial");
			expect(initial.passed).toBe(false);
			expect(initial.stderr).toContain("not implemented");

			const functionalSource = [
				"export function resolveDeployment(records, requestedService) {",
				"\tconst target = requestedService.trim().toLowerCase();",
				"\tlet selected;",
				"\tfor (const record of records) {",
				"\t\tif (record.enabled !== true || record.service.trim().toLowerCase() !== target) continue;",
				"\t\tif (!selected || record.revision >= selected.revision) selected = record;",
				"\t}",
				"\treturn selected",
				"\t\t? { route: selected.route, owner: selected.owner, revision: selected.revision }",
				'\t\t: { route: "route:fallback", owner: "team-ember", revision: 0 };',
				"}",
				"",
			].join("\n");
			writeFileSync(fixture.sourcePath, functionalSource, "utf8");
			const hiddenFailure = runCodingFixtureVerification(root, "initial");
			expect(hiddenFailure.passed).toBe(false);
			expect(hiddenFailure.stderr).toContain("HIDDEN_REPAIR_REQUIRED");
			expect(hiddenFailure.stderr).toContain('repairMarker must equal "omega-41"');

			writeFileSync(fixture.sourcePath, `export const repairMarker = "omega-41";\n${functionalSource}`, "utf8");
			const repaired = runCodingFixtureVerification(root, "repair");
			expect(repaired).toMatchObject({ passed: true, exitCode: 0 });
			expect(readFileSync(fixture.specPath, "utf8")).toContain("Only edit `src/router.mjs`");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
