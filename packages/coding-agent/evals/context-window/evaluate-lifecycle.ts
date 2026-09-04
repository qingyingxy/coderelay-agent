/**
 * Deterministic lifecycle evaluation for hard context windows.
 *
 * Uses the Faux Provider and local temporary sessions only. No network access,
 * credentials, or paid tokens are required.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	type Model,
	type FauxProviderRegistration,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	getHistoryResultCount,
	ModelRuntime,
	projectWorkflowSnapshot,
	type ResourceLoader,
	SessionManager,
	SessionWorkflowEventLog,
	SessionWorkflowSnapshotStore,
	SettingsManager,
	type WorkflowSnapshot,
	WorkflowController,
	WorkflowStore,
} from "../../src/index.ts";

export interface LifecycleEvaluationCheck {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

export interface LifecycleScenarioResult {
	readonly id: string;
	readonly passed: boolean;
	readonly checks: readonly LifecycleEvaluationCheck[];
	readonly evidence: Readonly<Record<string, unknown>>;
	readonly error?: string;
}

export interface ContextWindowLifecycleEvaluationReport {
	readonly schemaVersion: 1;
	readonly provider: "faux";
	readonly deterministic: true;
	readonly serialExecution: true;
	readonly passed: boolean;
	readonly passedScenarios: number;
	readonly totalScenarios: number;
	readonly results: readonly LifecycleScenarioResult[];
}

interface FauxEnvironment {
	readonly workspace: string;
	readonly sessionsDirectory: string;
	readonly faux: FauxProviderRegistration;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<string>;
	cleanup(): void;
}

type MessageTextPart = { type: "text"; text: string };

const ZERO_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	durationMs: 0,
} as const;

function check(id: string, passed: boolean, detail: string): LifecycleEvaluationCheck {
	return { id, passed, detail };
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Run the deterministic hard-context lifecycle evaluation.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function createFauxEnvironment(): Promise<FauxEnvironment> {
	const workspace = mkdtempSync(join(tmpdir(), "pi-context-lifecycle-"));
	const sessionsDirectory = join(workspace, "sessions");
	const faux = registerFauxProvider({
		models: [{ id: "faux-context-lifecycle", contextWindow: 100_000, maxTokens: 4_000 }],
	});
	try {
		const model = faux.getModel();
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		await modelRuntime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });
		return {
			workspace,
			sessionsDirectory,
			faux,
			modelRuntime,
			model,
			cleanup() {
				faux.unregister();
				rmSync(workspace, { recursive: true, force: true });
			},
		};
	} catch (error) {
		faux.unregister();
		rmSync(workspace, { recursive: true, force: true });
		throw error;
	}
}

async function createWindowedSession(
	environment: FauxEnvironment,
	sessionManager: SessionManager,
): Promise<AgentSession> {
	const created = await createAgentSession({
		cwd: environment.workspace,
		agentDir: environment.workspace,
		modelRuntime: environment.modelRuntime,
		model: environment.model,
		thinkingLevel: "off",
		tools: ["history"],
		resourceLoader: createResourceLoader(),
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true, keepRecentTokens: 16, reserveTokens: 1_000 },
			contextManagement: {
				mode: "windowed",
				reserveTokens: 10_000,
				notesHintMaxBytes: 4_000,
				historyResultMaxBytes: 16_000,
			},
			retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 30_000 } },
		}),
	});
	return created.session;
}

async function evaluateMultiWindow(): Promise<LifecycleScenarioResult> {
	const environment = await createFauxEnvironment();
	const sessionManager = SessionManager.create(environment.workspace, environment.sessionsDirectory);
	let session: AgentSession | undefined;
	try {
		session = await createWindowedSession(environment, sessionManager);
		environment.faux.setResponses([
			fauxAssistantMessage("early-value=alpha-17"),
			fauxAssistantMessage("middle window complete"),
		]);
		await session.prompt("Preserve early-value=alpha-17 through two context windows.");
		const earlyEntry = sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					messageText(entry.message).includes("early-value=alpha-17"),
			);
		sessionManager.upsertMemoryNote(
			{
				noteId: "multi-window-constraint",
				category: "constraint",
				content: "Keep early-value=alpha-17 available until final verification.",
				sourceEntryIds: earlyEntry ? [earlyEntry.id] : [],
			},
			4_000,
		);
		const first = await session.requestContextWindow("manual");
		if (!first) throw new Error("First context window was not created");
		await session.prompt("Advance the work through the middle window.");
		const middleEntry = sessionManager.getLeafId();
		const second = await session.requestContextWindow("manual");
		if (!second) throw new Error("Second context window was not created");

		const branch = sessionManager.getBranch();
		const activeEntries = sessionManager.buildContextEntries();
		const history = sessionManager.queryHistory({ action: "search", query: "early-value=alpha-17" }, 16_000);
		const checks = [
			check("two-hard-cuts", branch.filter(({ type }) => type === "context_window").length === 2, "two boundaries exist"),
			check(
				"lineage-advanced",
				first.windowIndex === 1 &&
					second.windowIndex === 2 &&
					second.firstWindowId === first.firstWindowId &&
					second.previousWindowId === first.windowId,
				"window index and first/previous IDs form one lineage",
			),
			check(
				"latest-window-active",
				activeEntries.length === 1 && activeEntries[0]?.id === second.id,
				"only the latest seed is active immediately after the second cut",
			),
			check(
				"old-messages-retained",
				earlyEntry !== undefined && middleEntry !== null && branch.some(({ id }) => id === earlyEntry.id) && branch.some(({ id }) => id === middleEntry),
				"early and middle-window entries remain persisted",
			),
			check(
				"note-survives-two-cuts",
				second.contextSeed.content.includes("early-value=alpha-17") && second.contextSeed.noteEntryIds.length === 1,
				"the durable Note is frozen into the second seed",
			),
			check("history-crosses-two-windows", getHistoryResultCount(history) >= 1, "History finds the early exact value"),
		];
		return {
			id: "multi-window-lineage",
			passed: checks.every(({ passed }) => passed),
			checks,
			evidence: {
				persistedEntries: branch.length,
				activeEntries: activeEntries.length,
				windowIndexes: [first.windowIndex, second.windowIndex],
				historyHits: getHistoryResultCount(history),
			},
		};
	} finally {
		session?.dispose();
		environment.cleanup();
	}
}

async function evaluateResume(): Promise<LifecycleScenarioResult> {
	const environment = await createFauxEnvironment();
	const sessionManager = SessionManager.create(environment.workspace, environment.sessionsDirectory);
	let session: AgentSession | undefined;
	try {
		session = await createWindowedSession(environment, sessionManager);
		environment.faux.setResponses([
			fauxAssistantMessage("resume-secret=delta-29"),
			fauxAssistantMessage("state persisted after boundary"),
		]);
		await session.prompt("Generate the exact resume value for later retrieval.");
		const boundary = await session.requestContextWindow("manual");
		if (!boundary) throw new Error("Resume boundary was not created");
		await session.prompt("Persist this post-boundary progress before restart.");
		const sessionFile = session.sessionFile;
		if (!sessionFile || !existsSync(sessionFile)) throw new Error("Persisted Session JSONL is unavailable");
		session.dispose();
		session = undefined;

		const resumedManager = SessionManager.open(sessionFile, environment.sessionsDirectory);
		session = await createWindowedSession(environment, resumedManager);
		const restoredText = JSON.stringify(session.messages);
		const history = resumedManager.queryHistory({ action: "search", query: "resume-secret=delta-29" }, 16_000);
		environment.faux.setResponses([fauxAssistantMessage("resumed-continuation-ok")]);
		await session.prompt("Continue after the process restart.");
		const checks = [
			check(
				"same-session-file",
				session.sessionFile === sessionFile,
				"resume continues the same Session JSONL",
			),
			check(
				"seed-restored",
				restoredText.includes("context-window") && restoredText.includes("post-boundary progress"),
				"active context is rebuilt from the persisted boundary and later messages",
			),
			check(
				"pre-boundary-not-active",
				!restoredText.includes("resume-secret=delta-29"),
				"the pre-boundary secret is not replayed into active context",
			),
			check("resume-history", getHistoryResultCount(history) >= 1, "History retrieves the pre-boundary secret after resume"),
			check(
				"resume-continues",
				messageText(session.messages.at(-1)).includes("resumed-continuation-ok"),
				"the resumed session can complete another provider turn",
			),
		];
		return {
			id: "resume-from-jsonl",
			passed: checks.every(({ passed }) => passed),
			checks,
			evidence: {
				sessionFile,
				windowIndex: boundary.windowIndex,
				historyHits: getHistoryResultCount(history),
				persistedEntries: resumedManager.getBranch().length,
			},
		};
	} finally {
		session?.dispose();
		environment.cleanup();
	}
}

async function evaluateBranchLifecycle(): Promise<LifecycleScenarioResult> {
	const environment = await createFauxEnvironment();
	try {
		const session = SessionManager.create(environment.workspace, environment.sessionsDirectory);
		session.appendMessage({ role: "user", content: "common branch root", timestamp: 1 });
		const commonId = session.appendMessage(fauxAssistantMessage("common branch state"));
		const originalFile = session.getSessionFile();
		if (!originalFile || !existsSync(originalFile)) throw new Error("Original Session JSONL is unavailable");

		const branchALineage = session.createNextContextWindowLineage();
		session.appendContextWindow({
			schemaVersion: 1,
			...branchALineage,
			reason: "manual",
			contextSeed: { schemaVersion: 1, content: "branch A seed", noteEntryIds: [], truncated: false },
			tokensBefore: 100,
		});
		session.appendMessage({ role: "user", content: "BRANCH_A_SECRET", timestamp: 2 });
		const branchALeaf = session.appendMessage(fauxAssistantMessage("branch A complete"));

		session.branch(commonId);
		const branchBLineage = session.createNextContextWindowLineage();
		session.appendContextWindow({
			schemaVersion: 1,
			...branchBLineage,
			reason: "manual",
			contextSeed: { schemaVersion: 1, content: "branch B seed", noteEntryIds: [], truncated: false },
			tokensBefore: 100,
		});
		session.appendMessage({ role: "user", content: "BRANCH_B_SECRET", timestamp: 3 });
		const branchBLeaf = session.appendMessage(fauxAssistantMessage("branch B complete"));
		const branchBSearchA = session.queryHistory({ action: "search", query: "BRANCH_A_SECRET" }, 16_000);
		const branchBSearchB = session.queryHistory({ action: "search", query: "BRANCH_B_SECRET" }, 16_000);

		session.branch(commonId);
		const rollbackContext = JSON.stringify(session.buildSessionContext().messages);
		const rollbackLineage = session.getContextWindowLineage();
		session.branch(branchBLeaf);
		const forkFile = session.createBranchedSession(branchBLeaf);
		if (!forkFile || !existsSync(forkFile)) throw new Error("Forked Session JSONL is unavailable");
		const forkSearchA = session.queryHistory({ action: "search", query: "BRANCH_A_SECRET" }, 16_000);
		const forkSearchB = session.queryHistory({ action: "search", query: "BRANCH_B_SECRET" }, 16_000);
		const original = SessionManager.open(originalFile, environment.sessionsDirectory);
		const originalEntries = JSON.stringify(original.getEntries());
		const checks = [
			check(
				"sibling-lineages-independent",
				branchALineage.firstWindowId !== branchBLineage.firstWindowId &&
					branchALineage.windowId !== branchBLineage.windowId,
				"each sibling branch starts an independent window lineage",
			),
			check(
				"history-branch-isolation",
				getHistoryResultCount(branchBSearchA) === 0 && getHistoryResultCount(branchBSearchB) >= 1,
				"branch B History cannot see branch A",
			),
			check(
				"rollback-removes-future",
				rollbackLineage === null && !rollbackContext.includes("BRANCH_A_SECRET") && !rollbackContext.includes("BRANCH_B_SECRET"),
				"rollback to the common ancestor rebuilds context without either future",
			),
			check(
				"fork-copies-one-path",
				getHistoryResultCount(forkSearchA) === 0 && getHistoryResultCount(forkSearchB) >= 1,
				"the forked Session JSONL contains branch B but not sibling branch A",
			),
			check(
				"original-remains-append-only",
				originalEntries.includes(branchALeaf) && originalEntries.includes(branchBLeaf),
				"the original Session JSONL retains both sibling branches",
			),
		];
		return {
			id: "fork-rollback-branch-isolation",
			passed: checks.every(({ passed }) => passed),
			checks,
			evidence: {
				originalEntries: original.getEntries().length,
				forkEntries: session.getEntries().length,
				branchBHistoryHits: getHistoryResultCount(branchBSearchB),
				forkHistoryHits: getHistoryResultCount(forkSearchB),
			},
		};
	} finally {
		environment.cleanup();
	}
}

function workflowPlan() {
	return {
		goal: "Implement and repair the lifecycle fixture",
		assumptions: [],
		steps: [
			{
				id: "implement",
				title: "Implement fixture",
				description: "Implement the fixture before delivery verification",
				dependsOn: [],
				fileIntents: [{ path: "src/fixture.ts", action: "modify" as const, reason: "Apply the fixture" }],
				verificationRequirementIds: ["quality-check"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "quality-check",
				kind: "manual" as const,
				description: "Verify the lifecycle fixture",
				required: true,
			},
		],
	};
}

async function evaluateAttemptRepair(): Promise<LifecycleScenarioResult> {
	const session = SessionManager.inMemory("C:/lifecycle-evaluation");
	const eventLog = new SessionWorkflowEventLog(session);
	const store = new WorkflowStore();
	let sequence = 0;
	const controller = new WorkflowController(eventLog, store, {
		createId: (kind) => `${kind}-${++sequence}`,
		now: () => "2026-09-04T00:00:00.000Z",
	});
	controller.startPlan({
		commandId: "start",
		workflowId: "workflow-repair-eval",
		rootTaskId: "root-repair-eval",
		planId: "plan-repair-eval",
		budget: { maxRetries: 3 },
		request: { text: "Exercise repair recovery", cwd: "C:/lifecycle-evaluation", attachments: [] },
	});
	controller.submitPlanForApproval({
		commandId: "submit",
		workflowId: "workflow-repair-eval",
		planId: "plan-repair-eval",
		content: workflowPlan(),
		plannerReadOnly: true,
	});
	controller.approvePlan({
		commandId: "approve",
		workflowId: "workflow-repair-eval",
		planId: "plan-repair-eval",
		comment: "Approved",
	});
	controller.refreshTaskReadiness({ commandId: "ready", workflowId: "workflow-repair-eval" });
	const implementationTask = store
		.listTasks("workflow-repair-eval")
		.find(({ sourcePlanStepId }) => sourcePlanStepId === "implement");
	if (!implementationTask) throw new Error("Implementation Task was not created");
	controller.prepareTaskAttempt({
		commandId: "prepare-implementation",
		workflowId: "workflow-repair-eval",
		taskId: implementationTask.id,
		attemptId: "attempt-implementation",
		assignment: { executorKind: "main_agent", agentId: "main" },
		writerLeaseId: "writer-lease-implementation",
	});
	controller.handleRuntimeEvent({
		type: "attempt_started",
		commandId: "start-implementation",
		workflowId: "workflow-repair-eval",
		taskId: implementationTask.id,
		attemptId: "attempt-implementation",
	});
	controller.handleRuntimeEvent({
		type: "attempt_succeeded",
		commandId: "succeed-implementation",
		workflowId: "workflow-repair-eval",
		taskId: implementationTask.id,
		attemptId: "attempt-implementation",
		verificationId: "verification-implementation",
		requirementId: "quality-check",
		usage: ZERO_USAGE,
		summary: "Implementation completed",
	});
	controller.completeTask({
		commandId: "complete-implementation",
		workflowId: "workflow-repair-eval",
		taskId: implementationTask.id,
		verificationId: "verification-implementation",
		summary: "Implementation completed",
		changedFiles: ["src/fixture.ts"],
	});
	controller.beginDeliveryVerification({ commandId: "begin-delivery", workflowId: "workflow-repair-eval" });
	controller.recordDeliveryVerification({
		commandId: "fail-delivery",
		workflowId: "workflow-repair-eval",
		verificationId: "verification-delivery-failed",
		requirementId: "quality-check",
		status: "failed",
		summary: "Expected repair-marker=omega-41",
		evidenceRefs: ["test-output:repair-marker-missing"],
	});
	controller.createRepairTask({
		commandId: "create-repair",
		workflowId: "workflow-repair-eval",
		taskId: "task-repair-1",
		failedVerificationId: "verification-delivery-failed",
	});
	controller.prepareTaskAttempt({
		commandId: "prepare-repair-1",
		workflowId: "workflow-repair-eval",
		taskId: "task-repair-1",
		attemptId: "attempt-repair-1",
		assignment: { executorKind: "main_agent", agentId: "main" },
		writerLeaseId: "writer-lease-repair-1",
	});
	controller.handleRuntimeEvent({
		type: "attempt_started",
		commandId: "start-repair-1",
		workflowId: "workflow-repair-eval",
		taskId: "task-repair-1",
		attemptId: "attempt-repair-1",
	});
	const snapshot = controller.createSnapshot("workflow-repair-eval");
	const snapshotEntryId = new SessionWorkflowSnapshotStore(session).append(snapshot);

	const recoveredStore = new WorkflowStore();
	const recovered = new WorkflowController(new SessionWorkflowEventLog(session), recoveredStore, { snapshot });
	recovered.recoverInterrupted({
		commandId: "recover-interrupted",
		workflowId: "workflow-repair-eval",
		reason: "Process restarted during repair",
	});
	recovered.prepareTaskAttempt({
		commandId: "prepare-repair-2",
		workflowId: "workflow-repair-eval",
		taskId: "task-repair-1",
		attemptId: "attempt-repair-2",
		assignment: { executorKind: "main_agent", agentId: "main" },
		writerLeaseId: "writer-lease-repair-2",
		recoveryOfAttemptId: "attempt-repair-1",
		recoveryReason: "Process restarted during repair",
	});
	const repairedSnapshot: WorkflowSnapshot = recovered.createSnapshot("workflow-repair-eval");
	const projection = projectWorkflowSnapshot(repairedSnapshot).content;
	const attempts = recoveredStore.listAttempts("task-repair-1");
	const repairTask = recoveredStore.getTask("task-repair-1");
	const failedVerification = recoveredStore.getVerification("verification-delivery-failed");
	const checks = [
		check(
			"repair-task-created",
			repairTask?.kind === "repair" && repairTask.repairForVerificationId === "verification-delivery-failed",
			"failed delivery verification creates a dedicated Repair Task",
		),
		check(
			"failed-verification-restored",
			failedVerification?.status === "failed" && failedVerification.summary.includes("omega-41"),
			"the failed Verification survives Snapshot restore",
		),
		check(
			"uncertain-attempt-interrupted",
			attempts[0]?.status === "interrupted",
			"the in-flight Repair Attempt is marked interrupted after restart",
		),
		check(
			"repair-attempt-recovered",
			attempts[1]?.id === "attempt-repair-2" &&
				attempts[1]?.number === 2 &&
				attempts[1]?.recoveryOfAttemptId === "attempt-repair-1" &&
				repairTask?.currentAttemptId === "attempt-repair-2",
			"a second Repair Attempt explicitly recovers the interrupted Attempt",
		),
		check(
			"repair-projected",
			projection.includes("workflow_task_id=task-repair-1") &&
				projection.includes("workflow_attempt_id=attempt-repair-2"),
			"the recovered Repair Task and Attempt appear in the authoritative projection",
		),
	];
	return {
		id: "attempt-repair-recovery",
		passed: checks.every(({ passed }) => passed),
		checks,
		evidence: {
			snapshotEntryId,
			snapshotSequence: snapshot.lastSequence,
			recoveredSnapshotSequence: repairedSnapshot.lastSequence,
			attemptStatuses: attempts.map(({ status }) => status),
		},
	};
}

async function evaluateOverflowRecovery(): Promise<LifecycleScenarioResult> {
	const environment = await createFauxEnvironment();
	const sessionManager = SessionManager.inMemory(environment.workspace);
	let session: AgentSession | undefined;
	try {
		session = await createWindowedSession(environment, sessionManager);
		let retryContext = "";
		environment.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			(context) => {
				retryContext = JSON.stringify(context.messages);
				return fauxAssistantMessage("overflow-recovery-ok");
			},
		]);
		await session.prompt("Recover this objective after a provider context overflow.");
		const branch = sessionManager.getBranch();
		const overflowIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
		);
		const boundaryIndex = branch.findIndex((entry) => entry.type === "context_window" && entry.reason === "overflow");
		const checks = [
			check(
				"overflow-before-boundary",
				overflowIndex >= 0 && boundaryIndex > overflowIndex,
				"the provider error is persisted before the recovery boundary",
			),
			check(
				"single-hard-cut-retry",
				environment.faux.state.callCount === 2 && branch.filter(({ type }) => type === "context_window").length === 1,
				"overflow recovery performs exactly one hard cut and one retry",
			),
			check(
				"retry-from-seed",
				retryContext.includes("Current objective: Recover this objective") && !retryContext.includes("prompt is too long"),
				"the retry receives the continuity seed without replaying the overflow error",
			),
			check(
				"recovery-completes",
				messageText(session.messages.at(-1)) === "overflow-recovery-ok",
				"the retried provider turn completes",
			),
		];
		return {
			id: "overflow-hard-cut-retry",
			passed: checks.every(({ passed }) => passed),
			checks,
			evidence: {
				providerCalls: environment.faux.state.callCount,
				overflowIndex,
				boundaryIndex,
			},
		};
	} finally {
		session?.dispose();
		environment.cleanup();
	}
}

async function runScenario(id: string, run: () => Promise<LifecycleScenarioResult>): Promise<LifecycleScenarioResult> {
	try {
		return await run();
	} catch (error) {
		return {
			id,
			passed: false,
			checks: [],
			evidence: {},
			error: error instanceof Error ? error.stack ?? error.message : String(error),
		};
	}
}

export async function runContextWindowLifecycleEvaluation(): Promise<ContextWindowLifecycleEvaluationReport> {
	const results = [
		await runScenario("multi-window-lineage", evaluateMultiWindow),
		await runScenario("resume-from-jsonl", evaluateResume),
		await runScenario("fork-rollback-branch-isolation", evaluateBranchLifecycle),
		await runScenario("attempt-repair-recovery", evaluateAttemptRepair),
		await runScenario("overflow-hard-cut-retry", evaluateOverflowRecovery),
	];
	const passedScenarios = results.filter(({ passed }) => passed).length;
	return {
		schemaVersion: 1,
		provider: "faux",
		deterministic: true,
		serialExecution: true,
		passed: passedScenarios === results.length,
		passedScenarios,
		totalScenarios: results.length,
		results,
	};
}

const isMain = process.argv[1]?.endsWith("evaluate-lifecycle.ts") ?? false;
if (isMain) {
	const report = await runContextWindowLifecycleEvaluation();
	console.log(JSON.stringify(report, null, 2));
	if (!report.passed) process.exitCode = 1;
}
