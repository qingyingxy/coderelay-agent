import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createEvidenceStatusTool,
	createOperationTool,
	createProbeTool,
	createVerificationTool,
	evaluateRepositoryFinalResponse,
	executeRepositoryPhase,
	initializeRepositoryFixture,
	injectGovernanceIntervention,
	parseRealRepositoryCliOptions,
	parseRealRepositoryTaskSet,
	repositoryDigest,
	repositoryPhasePromptHash,
	repositoryPhasePrompts,
	runRepositoryFixtureVerification,
	type VerificationExecution,
	verifyRealRepositoryTaskSet,
} from "../evals/context-window/evaluate-real-repository.ts";
import { type ExtensionContext, SessionManager } from "../src/index.ts";
import { assistantMsg } from "./utilities.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_SET_PATH = resolve(TEST_DIR, "../evals/context-window/real-repository-task-set.json");

function loadTaskSet() {
	return parseRealRepositoryTaskSet(JSON.parse(readFileSync(TASK_SET_PATH, "utf8")));
}

describe("repeated real-repository context-window evaluation", () => {
	it.each(["error", "aborted"] as const)(
		"surfaces a provider %s instead of reusing the preceding phase reply",
		async (stopReason) => {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(assistantMsg("DIAGNOSIS_READY"));
			await expect(
				executeRepositoryPhase(
					{
						sessionManager,
						prompt: async () => {
							sessionManager.appendMessage({
								...assistantMsg(""),
								content: [],
								stopReason,
								errorMessage: "Request timed out.",
							});
						},
					},
					"Phase 3",
				),
			).rejects.toThrow("PROVIDER_PHASE_FAILED: Request timed out.");
		},
	);

	it("requires a fresh final reply and returns only the current phase's reply", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(assistantMsg("DIAGNOSIS_READY"));
		await expect(executeRepositoryPhase({ sessionManager, prompt: async () => {} }, "Phase 3")).rejects.toThrow(
			"PHASE_REPLY_MISSING",
		);
		await expect(
			executeRepositoryPhase(
				{
					sessionManager,
					prompt: async () => {
						sessionManager.appendMessage(assistantMsg("I will implement the repair."));
						sessionManager.appendMessage({ ...assistantMsg(""), content: [] });
					},
				},
				"Phase 3",
			),
		).rejects.toThrow("PHASE_REPLY_MISSING");
		await expect(
			executeRepositoryPhase(
				{
					sessionManager,
					prompt: async () => {
						sessionManager.appendMessage(assistantMsg("REPAIR_REQUIRED"));
					},
				},
				"Phase 3",
			),
		).resolves.toMatchObject({ text: "REPAIR_REQUIRED" });
	});

	it("parses bounded serial matrix options", () => {
		expect(parseRealRepositoryCliOptions([])).toMatchObject({
			thinking: "medium",
			maxCostUsd: 3,
			repetitions: 1,
			boundaryTrigger: "runner",
			summaryKeepRecentTokens: 1,
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
		expect(parseRealRepositoryCliOptions(["--summary-keep-recent-tokens", "20000"])).toMatchObject({
			summaryKeepRecentTokens: 20000,
		});
		for (const invalid of ["0", "-1", "1.5", "NaN"]) {
			expect(() => parseRealRepositoryCliOptions(["--summary-keep-recent-tokens", invalid])).toThrow();
		}
		expect(() => parseRealRepositoryCliOptions(["--summary-keep-recent-tokens", "272000"])).toThrow("reserve");
		expect(() => parseRealRepositoryCliOptions(["--group", "B"])).toThrow("A or C");
		expect(() => parseRealRepositoryCliOptions(["--boundary-trigger", "automatic"])).toThrow("runner or model");
		expect(
			parseRealRepositoryCliOptions(["--memory-policy", "autonomous", "--scenario", "stale-evidence"]),
		).toMatchObject({ memoryPolicy: "autonomous", scenario: "stale-evidence" });
		expect(() => parseRealRepositoryCliOptions(["--memory-policy", "unknown"])).toThrow("scripted or autonomous");
		expect(() => parseRealRepositoryCliOptions(["--scenario", "changed-requirement"])).toThrow(
			"require --memory-policy autonomous",
		);
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

	it("keeps memory answers out of every phase prompt for every task", () => {
		for (const task of loadTaskSet().tasks) {
			for (const prompt of repositoryPhasePrompts(task)) {
				expect(prompt).not.toContain(task.probe.memoryToken);
				expect(prompt).not.toContain(task.probe.repairMarker);
			}
			const alternate = {
				...task,
				probe: { ...task.probe, memoryToken: "alternate-secret-token", repairMarker: "alternate-secret-marker" },
				expectedFinal: { ...task.expectedFinal, memory_token: "alternate-secret-token" },
			};
			expect(repositoryPhasePrompts(alternate)).toEqual(repositoryPhasePrompts(task));
			expect(repositoryPhasePromptHash(alternate)).toBe(repositoryPhasePromptHash(task));
			expect(
				evaluateRepositoryFinalResponse(JSON.stringify(task.expectedFinal), alternate)
					.filter(({ passed }) => !passed)
					.map(({ id }) => id),
			).toEqual(["final-value:memory_token"]);
		}
	});

	it("leaves memory choices open and requires the revised user constraint across a later boundary", () => {
		for (const task of loadTaskSet().tasks) {
			for (const scenario of [
				"continuity",
				"changed-requirement",
				"stale-evidence",
				"interrupted-operation",
			] as const) {
				const prompts = repositoryPhasePrompts(task, "autonomous", scenario);
				for (const prompt of prompts) {
					expect(prompt).not.toContain(task.probe.memoryToken);
					expect(prompt).not.toContain(task.probe.repairMarker);
					expect(prompt).not.toContain('"note_id"');
					expect(prompt).not.toContain('"query"');
				}
				const alternate = {
					...task,
					probe: { ...task.probe, memoryToken: "other-token", repairMarker: "other-marker" },
				};
				expect(repositoryPhasePromptHash(alternate, "autonomous", scenario)).toBe(
					repositoryPhasePromptHash(task, "autonomous", scenario),
				);
				if (scenario === "changed-requirement") {
					expect(prompts[0]).toContain('delivery_label="draft"');
					expect(prompts[1]).toContain('delivery_label="approved" replaces');
					expect(prompts[3]).not.toContain("approved");
					const expected = { ...task, expectedFinal: { ...task.expectedFinal, delivery_label: "approved" } };
					expect(
						evaluateRepositoryFinalResponse(
							JSON.stringify({ ...task.expectedFinal, delivery_label: "draft" }),
							expected,
						)
							.filter((check) => !check.passed)
							.map((check) => check.id),
					).toEqual(["final-value:delivery_label"]);
				}
			}
		}
	});

	it("persists probe consumption before disclosure and denies access after reopening or a boundary", async () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing task");
		const root = mkdtempSync(join(tmpdir(), "pi-evidence-probe-"));
		const ctx = {} as ExtensionContext;
		try {
			let manager = SessionManager.create(root, root);
			const kept = manager.appendMessage(assistantMsg("ready"));
			const tool = createProbeTool(task, () => manager);
			const result = await tool.execute("first", { probe_id: task.probe.probeId }, undefined, undefined, ctx);
			expect(JSON.stringify(result)).toContain(task.probe.memoryToken);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Session not persisted");
			manager = SessionManager.open(sessionFile, root);
			await expect(
				createProbeTool(task, () => manager).execute(
					"again",
					{ probe_id: task.probe.probeId },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow("PROBE_ALREADY_CLOSED");
			manager = SessionManager.inMemory();
			manager.appendCompaction("summary", kept, 100);
			await expect(
				tool.execute("late-first", { probe_id: task.probe.probeId }, undefined, undefined, ctx),
			).rejects.toThrow("PROBE_ALREADY_CLOSED");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not redisclose the marker through repeated initial calls or failed repair verification", async () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing task");
		const root = mkdtempSync(join(tmpdir(), "pi-evidence-verifier-"));
		const ctx = {} as ExtensionContext;
		try {
			const fixture = initializeRepositoryFixture(root, dirname(TASK_SET_PATH), task);
			writeFileSync(fixture.sourcePath, readFileSync(resolve(dirname(TASK_SET_PATH), task.referenceSource)));
			let manager = SessionManager.create(fixture.workspace, join(root, "sessions"));
			const kept = manager.appendMessage(assistantMsg("ready"));
			manager.appendCompaction("one", kept, 100);
			manager.appendCompaction("two", kept, 100);
			manager.appendCustomEntry("benchmark-phase", { phase: 3 });
			const executions: VerificationExecution[] = [];
			const tool = createVerificationTool(root, task, executions, () => manager);
			await expect(tool.execute("initial", { phase: "initial" }, undefined, undefined, ctx)).rejects.toThrow(
				task.probe.repairMarker,
			);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Session not persisted");
			manager = SessionManager.open(sessionFile, join(root, "sessions"));
			await expect(
				createVerificationTool(root, task, executions, () => manager).execute(
					"initial-again",
					{ phase: "initial" },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow("VERIFICATION_CLOSED");
			manager.appendCompaction("three", kept, 100);
			manager.appendCustomEntry("benchmark-phase", { phase: 4 });
			await expect(tool.execute("initial-late", { phase: "initial" }, undefined, undefined, ctx)).rejects.toThrow(
				"VERIFICATION_CLOSED",
			);
			try {
				await tool.execute("repair", { phase: "repair" }, undefined, undefined, ctx);
				throw new Error("Expected verification failure");
			} catch (error) {
				expect(String(error)).toContain("REPAIR_VERIFICATION_FAILED");
				expect(String(error)).not.toContain(task.probe.repairMarker);
			}
			expect(executions).toHaveLength(2);
			expect(executions[1]).toMatchObject({ markerPresentBeforeCall: false, passed: false });
			await expect(tool.execute("repair-again", { phase: "repair" }, undefined, undefined, ctx)).rejects.toThrow(
				"VERIFICATION_CLOSED",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("invalidates a passing source revision and grades the independently repaired revision", () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing task");
		const root = mkdtempSync(join(tmpdir(), "pi-stale-evidence-"));
		try {
			const fixture = initializeRepositoryFixture(root, dirname(TASK_SET_PATH), task);
			const repaired = `CW_RECOVERY_MARKER = ${JSON.stringify(task.probe.repairMarker)}\n${readFileSync(resolve(dirname(TASK_SET_PATH), task.referenceSource), "utf8")}`;
			writeFileSync(fixture.sourcePath, repaired);
			expect(runRepositoryFixtureVerification(root, task, "repair").passed).toBe(true);
			injectGovernanceIntervention(root, task, "stale-evidence");
			expect(runRepositoryFixtureVerification(root, task, "repair").officialPassed).toBe(false);
			writeFileSync(fixture.sourcePath, repaired);
			expect(runRepositoryFixtureVerification(root, task, "repair").passed).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records successful recovery before verification without disclosing the marker in the result", async () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing task");
		const root = mkdtempSync(join(tmpdir(), "pi-recovery-success-"));
		try {
			const fixture = initializeRepositoryFixture(root, dirname(TASK_SET_PATH), task);
			writeFileSync(
				fixture.sourcePath,
				`CW_RECOVERY_MARKER = ${JSON.stringify(task.probe.repairMarker)}\n${readFileSync(resolve(dirname(TASK_SET_PATH), task.referenceSource), "utf8")}`,
			);
			const manager = SessionManager.inMemory();
			const kept = manager.appendMessage(assistantMsg("ready"));
			for (let boundary = 0; boundary < 3; boundary++) manager.appendCompaction("summary", kept, 100);
			manager.appendCustomEntry("benchmark-phase", { phase: 4 });
			const executions: VerificationExecution[] = [];
			const result = await createVerificationTool(root, task, executions, () => manager).execute(
				"repair",
				{ phase: "repair" },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(JSON.stringify(result)).not.toContain(task.probe.repairMarker);
			expect(executions[0]).toMatchObject({
				passed: true,
				markerPresentBeforeCall: true,
				sourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("exposes only branch-local receipt metadata across reopen, including a consumed call with no durable result", async () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing task");
		const root = mkdtempSync(join(tmpdir(), "pi-evidence-status-"));
		const ctx = {} as ExtensionContext;
		try {
			let manager = SessionManager.create(root, root);
			const forkPoint = manager.appendMessage(assistantMsg("ready"));
			const status = createEvidenceStatusTool(() => manager);
			const before = manager.getBranch().length;
			expect((await status.execute("inspect", {}, undefined, undefined, ctx)).details.tools[0]).toMatchObject({
				state: "available",
				resultRecorded: false,
			});
			expect(manager.getBranch()).toHaveLength(before);
			const result = await createProbeTool(task, () => manager).execute(
				"probe-call",
				{ probe_id: task.probe.probeId },
				undefined,
				undefined,
				ctx,
			);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Session not persisted");
			manager = SessionManager.open(sessionFile, root);
			expect((await status.execute("lost-ack", {}, undefined, undefined, ctx)).details.tools[0]).toMatchObject({
				state: "consumed",
				resultRecorded: false,
				resultEntryId: null,
			});
			const resultId = manager.appendMessage({
				role: "toolResult",
				toolCallId: "probe-call",
				toolName: "benchmark_probe",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: Date.now(),
			});
			manager.appendCustomEntry("benchmark-phase", { phase: 4 });
			manager = SessionManager.open(sessionFile, root);
			const restored = await status.execute("restored", {}, undefined, undefined, ctx);
			expect(restored.details.tools[0]).toMatchObject({
				state: "consumed",
				resultRecorded: true,
				resultEntryId: resultId,
			});
			expect(JSON.stringify(restored)).not.toContain(task.probe.memoryToken);
			expect(JSON.stringify(restored)).not.toContain(task.probe.repairMarker);
			manager.branch(forkPoint);
			expect((await status.execute("sibling", {}, undefined, undefined, ctx)).details.tools[0]).toMatchObject({
				state: "available",
				resultRecorded: false,
				claimEntryId: null,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses durable task phases when normal retention causes no physical compaction", async () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing task");
		const root = mkdtempSync(join(tmpdir(), "pi-normal-retention-"));
		const ctx = {} as ExtensionContext;
		try {
			const fixture = initializeRepositoryFixture(root, dirname(TASK_SET_PATH), task);
			writeFileSync(fixture.sourcePath, readFileSync(resolve(dirname(TASK_SET_PATH), task.referenceSource)));
			const manager = SessionManager.inMemory();
			manager.appendCustomEntry("benchmark-phase", { phase: 3 });
			const status = createEvidenceStatusTool(() => manager);
			expect(
				(await status.execute("status", {}, undefined, undefined, ctx)).details.tools.map((item) => item.state),
			).toEqual(["unavailable", "available", "unavailable"]);
			await expect(
				createProbeTool(task, () => manager).execute(
					"late",
					{ probe_id: task.probe.probeId },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow("PROBE_ALREADY_CLOSED");
			const executions: VerificationExecution[] = [];
			const verify = createVerificationTool(root, task, executions, () => manager);
			await expect(verify.execute("initial", { phase: "initial" }, undefined, undefined, ctx)).rejects.toThrow(
				"HIDDEN_REPAIR_REQUIRED",
			);
			manager.appendCustomEntry("benchmark-phase", { phase: 4 });
			writeFileSync(
				fixture.sourcePath,
				`CW_RECOVERY_MARKER = ${JSON.stringify(task.probe.repairMarker)}\n${readFileSync(fixture.sourcePath, "utf8")}`,
			);
			await expect(verify.execute("repair", { phase: "repair" }, undefined, undefined, ctx)).resolves.toMatchObject({
				details: { passed: true },
			});
			expect(executions).toHaveLength(2);
			expect(
				manager.getBranch().some((entry) => entry.type === "compaction" || entry.type === "context_window"),
			).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reopens a committed operation receipt and records a duplicate attempt without a second effect", async () => {
		const task = loadTaskSet().tasks[0];
		if (!task) throw new Error("Missing task");
		const root = mkdtempSync(join(tmpdir(), "pi-operation-recovery-"));
		const ctx = {} as ExtensionContext;
		try {
			initializeRepositoryFixture(root, dirname(TASK_SET_PATH), task);
			writeFileSync(
				join(root, "operation-receipt.json"),
				JSON.stringify({ committed: false, commits: 0, applyAttempts: 0, inspections: 0 }),
			);
			injectGovernanceIntervention(root, task, "interrupted-operation");
			const tool = createOperationTool(root);
			expect(
				(await tool.execute("inspect", { action: "inspect" }, undefined, undefined, ctx)).details,
			).toMatchObject({ committed: true, commits: 1, applyAttempts: 0 });
			await expect(
				createOperationTool(root).execute("duplicate", { action: "apply" }, undefined, undefined, ctx),
			).rejects.toThrow("OPERATION_ALREADY_COMMITTED");
			expect(JSON.parse(readFileSync(join(root, "operation-receipt.json"), "utf8"))).toMatchObject({
				committed: true,
				commits: 1,
				applyAttempts: 1,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
