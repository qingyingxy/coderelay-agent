import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	evaluateRepositoryFinalResponse,
	initializeRepositoryFixture,
	parseRealRepositoryCliOptions,
	parseRealRepositoryTaskSet,
	repositoryDigest,
	repositoryPhasePromptHash,
	repositoryPhasePrompts,
	verifyRealRepositoryTaskSet,
} from "../evals/context-window/evaluate-real-repository.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_SET_PATH = resolve(TEST_DIR, "../evals/context-window/real-repository-task-set.json");

function loadTaskSet() {
	return parseRealRepositoryTaskSet(JSON.parse(readFileSync(TASK_SET_PATH, "utf8")));
}

describe("repeated real-repository context-window evaluation", () => {
	it("parses bounded serial matrix options", () => {
		expect(parseRealRepositoryCliOptions([])).toMatchObject({
			thinking: "medium",
			maxCostUsd: 3,
			repetitions: 1,
			boundaryTrigger: "runner",
		});
		expect(
			parseRealRepositoryCliOptions([
				"--thinking",
				"xhigh",
				"--repetitions",
				"3",
				"--task",
				"quixbugs-lis",
				"--group",
				"C",
				"--boundary-trigger",
				"model",
			]),
		).toMatchObject({
			thinking: "xhigh",
			repetitions: 3,
			taskId: "quixbugs-lis",
			group: "C",
			boundaryTrigger: "model",
		});
		expect(() => parseRealRepositoryCliOptions(["--repetitions", "1.5"])).toThrow("positive integer");
		expect(() => parseRealRepositoryCliOptions(["--group", "B"])).toThrow("A or C");
		expect(() => parseRealRepositoryCliOptions(["--boundary-trigger", "automatic"])).toThrow("runner or model");
	});

	it("rejects ambiguous identifiers and unsafe fixture paths", () => {
		const taskSet = loadTaskSet();
		const task = taskSet.tasks[0];
		expect(task).toBeDefined();
		expect(() =>
			parseRealRepositoryTaskSet({
				...taskSet,
				tasks: [{ ...task, repositoryFixture: "../outside" }],
			}),
		).toThrow("normalized relative path");
		expect(() =>
			parseRealRepositoryTaskSet({
				...taskSet,
				tasks: [{ ...task, expectedFinal: { ...task?.expectedFinal, memory_token: "wrong" } }],
			}),
		).toThrow("must equal the probe memoryToken");
	});

	it("pins three failing baselines with passing reference repairs", () => {
		const taskSet = loadTaskSet();
		const taskSetDirectory = dirname(TASK_SET_PATH);
		const report = verifyRealRepositoryTaskSet(taskSet, taskSetDirectory);
		expect(report.passed).toBe(true);
		expect(report.results).toHaveLength(3);
		for (const result of report.results) {
			expect(result).toMatchObject({
				baselineFailed: true,
				referenceReachedHiddenFailure: true,
				referenceRepairPassed: true,
				passed: true,
			});
			expect(result.actualBaseline).toBe(result.expectedBaseline);
		}
	});

	it("copies a digest-checked repository without exposing the reference repair", () => {
		const taskSet = loadTaskSet();
		const task = taskSet.tasks[0];
		if (!task) throw new Error("Missing first repository task");
		const root = mkdtempSync(join(tmpdir(), "pi-real-repository-fixture-"));
		try {
			const fixture = initializeRepositoryFixture(root, dirname(TASK_SET_PATH), task);
			expect(repositoryDigest(fixture.workspace)).toBe(task.repositoryBaseline);
			expect(fixture.initialFiles).not.toContain(task.referenceSource);
			expect(readFileSync(fixture.sourcePath, "utf8")).not.toContain("CW_RECOVERY_MARKER");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("grades the exact long-range final response", () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing first repository task");
		expect(
			evaluateRepositoryFinalResponse(JSON.stringify(task.expectedFinal), task).every(({ passed }) => passed),
		).toBe(true);
		expect(
			evaluateRepositoryFinalResponse(
				JSON.stringify({ ...task.expectedFinal, memory_token: "lost-after-cut" }),
				task,
			)
				.filter(({ passed }) => !passed)
				.map(({ id }) => id),
		).toEqual(["final-value:memory_token"]);
	});

	it("uses one auditable phase-prompt protocol for both strategies", () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing first repository task");
		const prompts = repositoryPhasePrompts(task);
		expect(prompts).toHaveLength(4);
		expect(prompts[0]).toContain("If the notes tool is available");
		expect(prompts[0]).toContain("If notes is unavailable");
		expect(prompts[3]).toContain("If the history tool is available");
		expect(prompts[3]).toContain("If history is unavailable");
		expect(prompts[3]).toContain("Do not call verification until the exact recovered marker line is present");
		expect(repositoryPhasePromptHash(task)).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(repositoryPhasePromptHash(task)).toBe(repositoryPhasePromptHash({ ...task }));
	});
});
