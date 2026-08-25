import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type AgentWorkspace,
	ModelGateway,
	PlanWorkflowRuntime,
	SessionManager,
	type SubagentModification,
	SubagentRuntime,
	type SubagentSessionConfig,
	type SubagentSessionFactory,
	WorkflowRuntimeRegistry,
	type WorkspaceArtifact,
	type WorkspacePrepareRequest,
	type WorkspaceProvider,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSession, FakeSubagentSessionFactory, SUBAGENT_HANDOFF } from "./subagent-fixtures.ts";

class RejectingAbortSession extends FakeSubagentSession {
	#rejectPrompt: ((error: Error) => void) | undefined;

	override prompt(message: string): Promise<void> {
		this.promptCalls.push(message);
		return new Promise((_resolve, reject) => {
			this.#rejectPrompt = reject;
		});
	}

	override async abort(): Promise<void> {
		this.abortCalls++;
		const error = new Error("Agent process exited (code=null signal=SIGTERM)");
		this.#rejectPrompt?.(error);
		this.fail(error);
	}
}

class RejectingFirstAbortSessionFactory implements SubagentSessionFactory {
	readonly sessions: FakeSubagentSession[] = [];

	create(config: SubagentSessionConfig): FakeSubagentSession {
		const session =
			this.sessions.length === 0
				? new RejectingAbortSession(config, "session-1")
				: new FakeSubagentSession(config, `session-${this.sessions.length + 1}`);
		this.sessions.push(session);
		return session;
	}
}

class TimeoutWaitingSession extends FakeSubagentSession {
	override prompt(message: string): Promise<void> {
		this.promptCalls.push(message);
		return new Promise(() => undefined);
	}

	override waitForIdle(): Promise<void> {
		return Promise.reject(new Error("Timeout waiting for agent to become idle"));
	}
}

class TimeoutWaitingSessionFactory implements SubagentSessionFactory {
	readonly sessions: FakeSubagentSession[] = [];

	create(config: SubagentSessionConfig): FakeSubagentSession {
		const session =
			this.sessions.length === 0
				? new TimeoutWaitingSession(config, "session-1")
				: new FakeSubagentSession(config, `session-${this.sessions.length + 1}`);
		this.sessions.push(session);
		return session;
	}
}

class RecoverableWorkspaceProvider implements WorkspaceProvider {
	readonly restoredArtifactIds: string[] = [];
	readonly #patchPath: string;
	#artifactSequence = 0;

	constructor(patchPath: string) {
		this.#patchPath = patchPath;
	}

	async prepare(request: WorkspacePrepareRequest): Promise<AgentWorkspace> {
		return {
			id: `workspace-${request.agentId}`,
			path: request.input.cwd,
			kind: "current",
			repositoryIdentity: "repository-test",
			repositoryRoot: request.input.cwd,
			assurance: "shared",
		};
	}

	async createArtifact(
		workspace: AgentWorkspace,
		modifications: readonly SubagentModification[],
	): Promise<WorkspaceArtifact> {
		this.#artifactSequence++;
		return {
			id: `artifact-${this.#artifactSequence}`,
			workspaceId: workspace.id,
			repositoryIdentity: workspace.repositoryIdentity ?? "repository-test",
			baselineCommit: "baseline",
			resultCommit: `result-${this.#artifactSequence}`,
			patchPath: this.#patchPath,
			changedFiles: [...new Set(modifications.map(({ path }) => path))],
			status: "created",
			createdAt: new Date().toISOString(),
		};
	}

	async restoreArtifact(_workspace: AgentWorkspace, artifact: WorkspaceArtifact): Promise<void> {
		this.restoredArtifactIds.push(artifact.id);
	}

	async release(_workspace: AgentWorkspace): Promise<void> {}

	async validateRecovery(): Promise<{
		readonly status: "available";
		readonly checkedAt: string;
		readonly details: readonly string[];
	}> {
		return {
			status: "available",
			checkedAt: new Date().toISOString(),
			details: ["Workspace and Artifact are available"],
		};
	}
}

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function routingGateway(): ModelGateway {
	const models = [model("test", "fast"), model("test", "strong")];
	return new ModelGateway(
		{
			getModel: (provider, id) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
			hasConfiguredAuth: () => true,
		},
		{ enabled: true, fastModel: "test/fast", strongModel: "test/strong" },
	);
}

function createPlan(): PlanWorkflowRuntime {
	const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: "workflow-retry",
		rootTaskId: "root-retry",
		planId: "plan-retry",
		request: { text: "Inspect then implement", cwd: "C:/repo", attachments: [] },
		budget: { maxConcurrentAgents: 1, maxAgentDepth: 1, maxRetries: 1 },
	});
	plan.submit({
		goal: "Inspect the repository",
		assumptions: [],
		steps: [
			{
				id: "inspect",
				kind: "agent",
				requiredAgentRole: "explorer",
				title: "Inspect the repository",
				description: "Find the implementation defect",
				dependsOn: [],
				fileIntents: [{ path: "src", action: "inspect", reason: "Locate the defect" }],
				verificationRequirementIds: [],
			},
		],
		risks: [],
		verificationRequirements: [],
	});
	plan.approve();
	return plan;
}

function createWorkerPlan(): PlanWorkflowRuntime {
	const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: "workflow-worker",
		rootTaskId: "root-worker",
		planId: "plan-worker",
		request: { text: "Implement the fix", cwd: "C:/repo", attachments: [] },
		budget: { maxDurationMs: 600_000, maxConcurrentAgents: 1, maxAgentDepth: 1, maxRetries: 1 },
	});
	plan.submit({
		goal: "Implement a bounded source fix",
		assumptions: ["The implementation point is known"],
		steps: [
			{
				id: "implement",
				kind: "agent",
				requiredAgentRole: "worker",
				title: "Implement the source fix",
				description: "Replace the defective source behavior",
				dependsOn: [],
				fileIntents: [{ path: "src/index.ts", action: "modify", reason: "Fix the defect" }],
				verificationRequirementIds: [],
			},
			{
				id: "verify",
				kind: "command",
				command: "node verify.js",
				title: "Run focused verification",
				description: "Run the deterministic verification after implementation",
				dependsOn: ["implement"],
				fileIntents: [],
				verificationRequirementIds: ["tests"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "tests",
				kind: "test",
				description: "Run the focused verification",
				required: true,
				command: "node verify.js",
			},
		],
	});
	plan.approve();
	return plan;
}

describe("PlanWorkflowRuntime Subagent retry", () => {
	it("sends a compact execution contract to one bounded Worker", async () => {
		const plan = createWorkerPlan();
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const [execution] = await plan.startReadySubagents(subagents, 1);
		const prompt = sessions.sessions[0]?.promptCalls[0] ?? "";
		expect(prompt).toContain("Execution role: implementation Worker");
		expect(prompt).toContain("- modify src/index.ts: Fix the defect");
		expect(prompt).toContain("- node verify.js");
		expect(prompt).toContain("same Session");
		expect(prompt).not.toContain("Approved Plan:");
		expect(prompt).not.toContain('"assumptions"');
		expect(execution?.agent.budget.maxDurationMs).toBeGreaterThan(180_000);
		expect(execution?.agent.budget.maxDurationMs).toBeLessThanOrEqual(240_000);

		await subagents.interrupt(execution!.agent.id, "Test completed");
		await execution?.completion;
		await subagents.dispose();
	});

	it("supplements an omitted verification command in the original Worker Session without escalating", async () => {
		const plan = createWorkerPlan();
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			workspaceProvider: new RecoverableWorkspaceProvider("C:/repo/unused.patch"),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			maxAgents: 1,
			modelGateway: routingGateway(),
			verificationRunner: async () => ({ exitCode: 0, output: "verification passed", timedOut: false }),
		});

		const [execution] = await plan.startReadySubagents(subagents, 1);
		const session = sessions.sessions[0]!;
		session.emit({
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: { path: "src/index.ts" },
		});
		session.emit({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			isError: false,
		});
		session.complete(SUBAGENT_HANDOFF);

		await vi.waitFor(() => expect(session.promptCalls).toHaveLength(2));
		expect(session.promptCalls[1]).toContain("The implementation patch already exists");
		expect(session.promptCalls[1]).toContain("Run this exact command now with the bash tool: node verify.js");
		expect(session.promptCalls[1]).toContain("A textual claim that it passed is not verification evidence");
		expect(sessions.sessions).toHaveLength(1);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "verify-1",
			toolName: "bash",
			args: { command: "node verify.js" },
		});
		session.emit({
			type: "tool_execution_end",
			toolCallId: "verify-1",
			toolName: "bash",
			isError: false,
			result: "verification passed",
		});
		session.complete(SUBAGENT_HANDOFF);

		await expect(execution?.completion).resolves.toMatchObject({ status: "completed" });
		expect(plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "implement")?.status).toBe("succeeded");
		expect(plan.attempts.map(({ status }) => status)).toEqual(["succeeded"]);
		expect(sessions.sessions).toHaveLength(1);
		await subagents.dispose();
	});

	it("escalates to a strong Worker only after omitted verification still fails in the original Session", async () => {
		const plan = createWorkerPlan();
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			workspaceProvider: new RecoverableWorkspaceProvider("C:/repo/unused.patch"),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			maxAgents: 1,
			modelGateway: routingGateway(),
			verificationRunner: async () => ({ exitCode: 1, output: "verification failed", timedOut: false }),
		});

		const [first] = await plan.startReadySubagents(subagents, 1);
		const firstSession = sessions.sessions[0]!;
		firstSession.emit({
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: { path: "src/index.ts" },
		});
		firstSession.emit({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			isError: false,
		});
		firstSession.complete(SUBAGENT_HANDOFF);

		await vi.waitFor(() => expect(firstSession.promptCalls).toHaveLength(2));
		firstSession.emit({
			type: "tool_execution_start",
			toolCallId: "verify-1",
			toolName: "bash",
			args: { command: "node verify.js" },
		});
		firstSession.emit({
			type: "tool_execution_end",
			toolCallId: "verify-1",
			toolName: "bash",
			isError: true,
			result: "verification failed",
		});
		firstSession.complete(SUBAGENT_HANDOFF);

		await expect(first?.completion).resolves.toMatchObject({
			status: "failed",
			errorCode: "subagent.verification_failed",
			error: expect.stringContaining("required command failed: node verify.js"),
		});
		expect(firstSession.promptCalls).toHaveLength(2);
		expect(sessions.sessions).toHaveLength(1);
		expect(plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "implement")?.status).toBe("ready");

		const [second] = await plan.startReadySubagents(subagents, 1);
		expect(second?.agent.modelRoute).toMatchObject({
			tier: "strong",
			modelName: "test/strong",
			reasonCode: "model.verification_failure_escalated_strong",
		});
		expect(second?.agent.retryOfAgentId).toBe(first?.agent.id);
		expect(sessions.sessions).toHaveLength(2);
		await subagents.interrupt(second!.agent.id, "Test completed");
		await second?.completion;
		await subagents.dispose();
	});

	it("binds a successful second Agent attempt and completes a Task without an explicit verification", async () => {
		const plan = createPlan();
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			maxAgents: 1,
			modelGateway: routingGateway(),
		});

		const [first] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[0]?.complete("not a structured Handoff");
		await first?.completion;
		expect(plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "inspect")).toMatchObject({
			status: "ready",
			verificationRequirements: [expect.objectContaining({ required: true })],
		});

		const [second] = await plan.startReadySubagents(subagents, 1);
		expect(second?.agent.modelRoute).toMatchObject({
			tier: "strong",
			modelName: "test/strong",
			reasonCode: "model.no_progress_escalated_strong",
		});
		expect(second?.agent.retryOfAgentId).toBe(first?.agent.id);
		expect(sessions.sessions[1]?.promptCalls[0]).toContain(
			"The previous attempt did not produce a valid structured Handoff.",
		);
		expect(sessions.sessions[1]?.promptCalls[0]).toContain("non-empty conclusion string");
		expect(sessions.sessions[1]?.promptCalls[0]).toContain("every other field must be an array");
		sessions.sessions[1]?.complete(SUBAGENT_HANDOFF);
		await second?.completion;

		const task = plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "inspect");
		expect(task).toMatchObject({
			status: "succeeded",
			assignment: { agentId: second?.agent.id },
			result: { handoffId: expect.any(String) },
		});
		expect(plan.attempts.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
		expect(subagents.availableSlots(plan.workflow.id)).toBe(1);
		expect(subagents.get(second!.agent.id)).toMatchObject({ sessionReleasedAt: expect.any(String) });
		await subagents.dispose();
	});

	it("starts a normal retry when an interrupted Agent has a failed Workflow Attempt", async () => {
		const plan = createPlan();
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const [first] = await plan.startReadySubagents(subagents, 1);
		await subagents.interrupt(first!.agent.id, "Budget exhausted: maxTurns");
		await first?.completion;
		expect(plan.attempts[0]).toMatchObject({ status: "failed" });

		const [second] = await plan.startReadySubagents(subagents, 1);
		expect(second?.agent).toMatchObject({ recoveryOfAgentId: undefined, retryOfAgentId: first?.agent.id });
		sessions.sessions[1]?.complete(SUBAGENT_HANDOFF);
		await second?.completion;

		expect(plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "inspect")?.status).toBe("succeeded");
		expect(plan.attempts.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
		await subagents.dispose();
	});

	it("treats an internal no-progress abort as a retryable Attempt and escalates the next Worker", async () => {
		const plan = createWorkerPlan();
		const sessions = new RejectingFirstAbortSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			maxAgents: 1,
			modelGateway: routingGateway(),
			verificationRunner: async () => ({ exitCode: 0, output: "verification passed", timedOut: false }),
		});

		const firstDispatch = plan.startReadySubagents(subagents, 1);
		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(1));
		const firstSession = sessions.sessions[0]!;
		await vi.waitFor(() => expect(firstSession.promptCalls).toHaveLength(1));
		const turn = {
			type: "turn_end",
			message: {
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { total: 0.001 },
				},
			},
		};
		for (let index = 0; index < 20; index++) firstSession.emit(turn);

		const [first] = await firstDispatch;
		await expect(first?.completion).resolves.toMatchObject({
			status: "interrupted",
			errorCode: "subagent.no_progress",
			error: expect.stringContaining("No implementation progress after 20 Worker turns"),
		});
		expect(plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "implement")).toMatchObject({
			status: "ready",
		});
		expect(plan.attempts).toEqual([expect.objectContaining({ status: "failed" })]);

		const [second] = await plan.startReadySubagents(subagents, 1);
		expect(second?.agent.modelRoute).toMatchObject({
			tier: "strong",
			modelName: "test/strong",
			reasonCode: "model.no_progress_escalated_strong",
		});
		expect(second?.agent.retryOfAgentId).toBe(first?.agent.id);
		expect(sessions.sessions[1]?.promptCalls[0]).toContain(
			"The previous attempt produced no code. Implement the listed file operations now",
		);
		const secondSession = sessions.sessions[1]!;
		secondSession.emit({
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: { path: "src/index.ts" },
		});
		secondSession.emit({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			isError: false,
		});
		secondSession.emit({
			type: "tool_execution_start",
			toolCallId: "verify-1",
			toolName: "bash",
			args: { command: "node verify.js" },
		});
		secondSession.emit({
			type: "tool_execution_end",
			toolCallId: "verify-1",
			toolName: "bash",
			isError: false,
			result: "verification passed",
		});
		secondSession.complete(SUBAGENT_HANDOFF);
		await expect(second?.completion).resolves.toMatchObject({ status: "completed" });
		expect(plan.attempts.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
		await subagents.dispose();
	});

	it("restores a failed verification patch and diagnostics into a strong Worker retry", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-plan-verification-retry-"));
		const patchPath = join(root, "partial.patch");
		writeFileSync(patchPath, "diff --git a/src/index.ts b/src/index.ts\n", "utf8");
		const plan = createWorkerPlan();
		const sessions = new FakeSubagentSessionFactory();
		const workspaceProvider = new RecoverableWorkspaceProvider(patchPath);
		const verificationResults = [
			{ exitCode: 1, output: "AssertionError: expected cache refresh", timedOut: false },
			{ exitCode: 0, output: "verification passed", timedOut: false },
		];
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			workspaceProvider,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			maxAgents: 1,
			modelGateway: routingGateway(),
			verificationRunner: async () => verificationResults.shift()!,
		});

		try {
			const [first] = await plan.startReadySubagents(subagents, 1);
			const firstSession = sessions.sessions[0]!;
			firstSession.emit({
				type: "tool_execution_start",
				toolCallId: "edit-1",
				toolName: "edit",
				args: { path: "src/index.ts" },
			});
			firstSession.emit({
				type: "tool_execution_end",
				toolCallId: "edit-1",
				toolName: "edit",
				isError: false,
			});
			firstSession.emit({
				type: "tool_execution_start",
				toolCallId: "verify-1",
				toolName: "bash",
				args: { command: "node verify.js" },
			});
			firstSession.emit({
				type: "tool_execution_end",
				toolCallId: "verify-1",
				toolName: "bash",
				isError: true,
				result: "AssertionError: expected cache refresh",
			});
			firstSession.complete(SUBAGENT_HANDOFF);

			await vi.waitFor(() => expect(firstSession.promptCalls).toHaveLength(2));
			expect(firstSession.promptCalls[1]).toContain("Stay in this same Worker Session");
			firstSession.complete(SUBAGENT_HANDOFF);
			await vi.waitFor(() => expect(firstSession.promptCalls).toHaveLength(3));
			firstSession.complete(SUBAGENT_HANDOFF);

			await expect(first?.completion).resolves.toMatchObject({
				status: "failed",
				errorCode: "subagent.verification_failed",
				artifact: { changedFiles: ["src/index.ts"] },
			});
			expect(plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "implement")).toMatchObject({
				status: "ready",
			});
			expect(plan.attempts[0]).toMatchObject({
				status: "failed",
				failure: { code: "subagent.verification_failed" },
			});

			const [second] = await plan.startReadySubagents(subagents, 1);
			expect(second?.agent.modelRoute).toMatchObject({
				tier: "strong",
				modelName: "test/strong",
				reasonCode: "model.verification_failure_escalated_strong",
			});
			expect(second?.agent.retryOfAgentId).toBe(first?.agent.id);
			expect(second?.agent.recoveryContext).toMatchObject({
				artifact: { changedFiles: ["src/index.ts"] },
				artifactPatch: expect.stringContaining("diff --git a/src/index.ts"),
				commandDiagnostics: expect.arrayContaining([
					expect.objectContaining({
						command: "node verify.js",
						status: "failed",
						output: "AssertionError: expected cache refresh",
					}),
					expect.objectContaining({
						command: "node verify.js",
						status: "failed",
						source: "controlled",
					}),
				]),
			});
			expect(workspaceProvider.restoredArtifactIds).toEqual(["artifact-1"]);
			const retryPrompt = sessions.sessions[1]?.promptCalls[0] ?? "";
			expect(retryPrompt).toContain("Continue from these changed files: src/index.ts");
			expect(retryPrompt).toContain("node verify.js: failed");
			expect(retryPrompt).toContain("AssertionError: expected cache refresh");

			const secondSession = sessions.sessions[1]!;
			secondSession.emit({
				type: "tool_execution_start",
				toolCallId: "edit-2",
				toolName: "edit",
				args: { path: "src/index.ts" },
			});
			secondSession.emit({
				type: "tool_execution_end",
				toolCallId: "edit-2",
				toolName: "edit",
				isError: false,
			});
			secondSession.emit({
				type: "tool_execution_start",
				toolCallId: "verify-2",
				toolName: "bash",
				args: { command: "node verify.js" },
			});
			secondSession.emit({
				type: "tool_execution_end",
				toolCallId: "verify-2",
				toolName: "bash",
				isError: false,
				result: "verification passed",
			});
			secondSession.complete(SUBAGENT_HANDOFF);
			await expect(second?.completion).resolves.toMatchObject({ status: "completed" });
			expect(plan.attempts.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
		} finally {
			await subagents.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("converts a normal waitForIdle timeout into a retryable Attempt", async () => {
		const plan = createWorkerPlan();
		const sessions = new TimeoutWaitingSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			maxAgents: 1,
			modelGateway: routingGateway(),
		});

		const [first] = await plan.startReadySubagents(subagents, 1);
		await expect(first?.completion).resolves.toMatchObject({
			status: "failed",
			errorCode: "subagent.duration_exceeded",
		});
		expect(plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "implement")).toMatchObject({
			status: "ready",
		});
		expect(plan.attempts[0]).toMatchObject({
			status: "failed",
			failure: { code: "subagent.duration_exceeded" },
		});

		const [second] = await plan.startReadySubagents(subagents, 1);
		expect(second?.agent.modelRoute).toMatchObject({
			tier: "strong",
			modelName: "test/strong",
			reasonCode: "model.no_progress_escalated_strong",
		});
		await subagents.interrupt(second!.agent.id, "Test completed");
		await second?.completion;
		await subagents.dispose();
	});
});
