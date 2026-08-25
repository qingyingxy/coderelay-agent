import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	BUILTIN_AGENT_PROFILES,
	type ControlledVerificationResult,
	type ControlledVerificationRunner,
	FULL_PERMISSION_SET,
	ModelGateway,
	RuntimePolicyError,
	SessionManager,
	SessionSubagentPersistence,
	SubagentRuntime,
	type SubagentService,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { ZERO_USAGE } from "./fixtures.ts";
import { FakeSubagentSessionFactory, SUBAGENT_HANDOFF, subagentHandoff } from "./subagent-fixtures.ts";

function spawnInput(profile = BUILTIN_AGENT_PROFILES.explorer) {
	return {
		workflowId: "workflow-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		cwd: "C:/repo",
		profile,
		parentPermission: FULL_PERMISSION_SET,
		workflowPermission: FULL_PERMISSION_SET,
		taskPermission: FULL_PERMISSION_SET,
		parentBudget: { maxAgentDepth: 2, maxRetries: 1 },
		workflowBudget: { maxConcurrentAgents: 2, maxAgentDepth: 2, maxRetries: 1 },
		taskBudget: { maxRetries: 1 },
	};
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

function runtime(
	factory: FakeSubagentSessionFactory,
	modelGateway?: ModelGateway,
	verificationRunner: ControlledVerificationRunner = async () => ({
		exitCode: 0,
		output: "verification passed",
		timedOut: false,
	}),
): SubagentRuntime {
	let sequence = 0;
	return new SubagentRuntime({
		sessionFactory: factory,
		writerLeaseRegistry: new WriterLeaseRegistry(),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
		createId: (kind) => `${kind}-${++sequence}`,
		now: () => 100,
		modelGateway,
		verificationRunner,
	});
}

describe("SubagentRuntime", () => {
	it("creates an isolated read-only Session and completes with a validated Handoff", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject: SubagentService = runtime(factory);
		const agent = await subject.spawn(spawnInput());

		expect(agent).toMatchObject({
			id: "agent-1",
			sessionId: "session-1",
			scope: "task",
			backend: "rpc",
			status: "idle",
			depth: 1,
		});
		expect(factory.sessions[0]?.config.toolNames).toEqual(["read", "grep", "find", "ls"]);

		await subject.send(agent.id, "Inspect the Workflow");
		factory.sessions[0]?.complete(SUBAGENT_HANDOFF, {
			...ZERO_USAGE,
			inputTokens: 20,
			outputTokens: 10,
			turns: 1,
		});
		const result = await subject.wait(agent.id);

		expect(result).toMatchObject({
			status: "completed",
			handoff: {
				agentId: agent.id,
				conclusion: "Inspection completed",
			},
			usage: {
				inputTokens: 20,
				outputTokens: 10,
				turns: 1,
			},
		});
		expect(subject.get(agent.id)).toMatchObject({
			status: "idle",
			handoffId: "handoff-2",
		});
		await expect(subject.send(agent.id, "Run again")).rejects.toMatchObject({
			code: "subagent.run_terminal",
		});
	});

	it("resumes a completed Agent in the same Session and keeps a Transcript", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn(spawnInput());

		await subject.send(agent.id, "Inspect first");
		factory.sessions[0]?.complete(SUBAGENT_HANDOFF);
		await subject.wait(agent.id);
		await subject.resume(agent.id, "Inspect the follow-up");
		factory.sessions[0]?.complete(subagentHandoff({ conclusion: "Follow-up completed" }));
		const resumed = await subject.wait(agent.id);

		expect(resumed).toMatchObject({
			status: "completed",
			handoff: {
				conclusion: "Follow-up completed",
			},
		});
		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.promptCalls).toEqual(["Inspect first", "Inspect the follow-up"]);
		expect(subject.getTranscript(agent.id)).toMatchObject({
			agentId: agent.id,
			sessionId: "session-1",
			released: false,
			entries: [
				{ type: "prompt", text: "Inspect first" },
				{ type: "assistant" },
				{ type: "resume", text: "Inspect the follow-up" },
				{ type: "prompt", text: "Inspect the follow-up" },
				{ type: "assistant" },
			],
		});
		expect(subject.events(agent.id).map(({ type }) => type)).toContain("resumed");

		await subject.release(agent.id);
		expect(subject.getTranscript(agent.id).released).toBe(true);
		await expect(subject.resume(agent.id, "One more pass")).rejects.toMatchObject({
			code: "subagent.resume_unavailable",
		});
	});

	it("releases completed Sessions without replacing their successful result", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			maxAgents: 1,
		});
		const agent = await subject.spawn(spawnInput());
		await subject.send(agent.id, "Inspect");
		factory.sessions[0]?.complete(SUBAGENT_HANDOFF);
		const completed = await subject.wait(agent.id);
		expect(subject.availableSlots("workflow-1")).toBe(0);

		await subject.release(agent.id);

		expect(await subject.wait(agent.id)).toEqual(completed);
		expect(subject.get(agent.id)).toMatchObject({
			status: "idle",
			handoffId: completed.handoff?.id,
			sessionReleasedAt: expect.any(String),
		});
		expect(subject.availableSlots("workflow-1")).toBe(1);
		expect(factory.sessions[0]?.stopCalls).toBe(1);
		await subject.dispose();
	});

	it("streams steering, records successful mutations, and releases the Writer Lease", async () => {
		const factory = new FakeSubagentSessionFactory();
		const leaseRegistry = new WriterLeaseRegistry();
		let sequence = 0;
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			writerLeaseRegistry: leaseRegistry,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			createId: (kind) => `${kind}-${++sequence}`,
			now: () => 100,
		});
		const agent = await subject.spawn(spawnInput(BUILTIN_AGENT_PROFILES.worker));
		expect(agent.effectivePermissions).toMatchObject({
			executeCommands: true,
			network: false,
		});
		expect(factory.sessions[0]?.config.toolNames).toContain("bash");

		await subject.send(agent.id, "Implement the Task");
		expect(leaseRegistry.get(agent.workspace!.repositoryIdentity!)).toMatchObject({
			workflowId: "workflow-1",
			taskId: "task-1",
		});
		await subject.send(agent.id, "Also check the CLI");
		const session = factory.sessions[0]!;
		session.emit({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "edit",
			args: { path: "src/index.ts" },
		});
		session.emit({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "edit",
			isError: false,
		});
		session.complete(subagentHandoff({ changedFiles: ["src/index.ts"] }));
		const result = await subject.wait(agent.id);

		expect(session.steerCalls).toEqual(["Also check the CLI"]);
		expect(result.modifications).toEqual([{ path: "src/index.ts", operation: "edit", toolCallId: "tool-1" }]);
		expect(leaseRegistry.get(agent.workspace!.repositoryIdentity!)).toBeUndefined();
	});

	it("keeps verification repair in the same Worker Session", async () => {
		const factory = new FakeSubagentSessionFactory();
		const controlledResults: ControlledVerificationResult[] = [
			{ exitCode: 1, output: "one assertion failed", timedOut: false },
			{ exitCode: 0, output: "verification passed", timedOut: false },
		];
		const subject = runtime(factory, undefined, async () => controlledResults.shift()!);
		const agent = await subject.spawn({
			...spawnInput(BUILTIN_AGENT_PROFILES.worker),
			verificationCommands: ["node verify.js"],
		});
		const session = factory.sessions[0]!;
		await subject.send(agent.id, "Implement and verify");

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
			isError: true,
			result: "one assertion failed",
		});
		await vi.waitFor(() => expect(session.steerCalls).toHaveLength(1));
		expect(session.steerCalls[0]).toContain("Stay in this same Worker Session");

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
		session.emit({
			type: "tool_execution_start",
			toolCallId: "verify-2",
			toolName: "bash",
			args: { command: "node verify.js" },
		});
		session.emit({
			type: "tool_execution_end",
			toolCallId: "verify-2",
			toolName: "bash",
			isError: false,
			result: "verification passed",
		});
		session.complete(
			subagentHandoff({
				conclusion: "Implementation and verification completed",
				changedFiles: ["src/index.ts"],
				verificationSummary: ["node verify.js passed"],
			}),
		);

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "completed",
			handoff: { conclusion: "Implementation and verification completed" },
		});
		expect(factory.sessions).toHaveLength(1);
	});

	it.each(["node verify.js; echo ok", "node verify.js | head -80"])(
		"does not let a wrapped command satisfy required verification: %s",
		async (wrappedCommand) => {
			const factory = new FakeSubagentSessionFactory();
			const verificationRunner = vi.fn<ControlledVerificationRunner>();
			const subject = runtime(factory, undefined, verificationRunner);
			const agent = await subject.spawn({
				...spawnInput(BUILTIN_AGENT_PROFILES.worker),
				verificationCommands: ["node verify.js"],
			});
			const session = factory.sessions[0]!;
			await subject.send(agent.id, "Implement and verify");
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
			session.emit({
				type: "tool_execution_start",
				toolCallId: "wrapped-1",
				toolName: "bash",
				args: { command: wrappedCommand },
			});
			session.emit({
				type: "tool_execution_end",
				toolCallId: "wrapped-1",
				toolName: "bash",
				isError: false,
				result: "wrapper returned zero",
			});
			session.fail(new Error("Timeout waiting for agent to become idle"));

			await expect(subject.wait(agent.id)).resolves.toMatchObject({
				status: "failed",
				errorCode: "subagent.duration_exceeded",
			});
			expect(verificationRunner).not.toHaveBeenCalled();
		},
	);

	it("rejects an exact command when controlled verification returns a non-zero exit code", async () => {
		const factory = new FakeSubagentSessionFactory();
		const verificationRunner = vi.fn<ControlledVerificationRunner>(async () => ({
			exitCode: 1,
			output: "controlled assertion failed",
			timedOut: false,
		}));
		const subject = runtime(factory, undefined, verificationRunner);
		const agent = await subject.spawn({
			...spawnInput(BUILTIN_AGENT_PROFILES.worker),
			verificationCommands: ["node verify.js"],
		});
		const session = factory.sessions[0]!;
		await subject.send(agent.id, "Implement and verify");
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
			result: "agent reported success",
		});

		await vi.waitFor(() => expect(session.steerCalls[0]).toContain("controlled assertion failed"));
		session.fail(new Error("Timeout waiting for agent to become idle"));
		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "failed",
		});
	});

	it("uses the frozen sandbox environment for controlled verification", async () => {
		const factory = new FakeSubagentSessionFactory();
		const verificationRunner = vi.fn<ControlledVerificationRunner>(async () => ({
			exitCode: 0,
			output: "passed",
			timedOut: false,
		}));
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			verificationRunner,
			sandboxBackend: {
				prepare: async ({ agentId }) => ({
					id: `sandbox-${agentId}`,
					environment: {
						PI_EVALUATION_NODE: "trusted-node",
						PI_EVALUATION_NODE_MODULES: "trusted-modules",
					},
					verification: {
						assurance: "process-restricted",
						mode: "best-effort",
						enforced: [],
						missingGuarantees: [],
						platform: process.platform,
						planDigest: "digest",
					},
				}),
				verify: async (handle) => handle.verification,
				release: async () => undefined,
			},
		});
		const agent = await subject.spawn({
			...spawnInput(BUILTIN_AGENT_PROFILES.worker),
			verificationCommands: ["node verify.js"],
		});
		const session = factory.sessions[0]!;
		await subject.send(agent.id, "Implement and verify");
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
			result: "export PI_EVALUATION_NODE=untrusted-node",
		});
		await vi.waitFor(() => expect(verificationRunner).toHaveBeenCalledOnce());

		expect(verificationRunner.mock.calls[0]?.[0].environment).toMatchObject({
			PI_EVALUATION_NODE: "trusted-node",
			PI_EVALUATION_NODE_MODULES: "trusted-modules",
		});
		await subject.interrupt(agent.id);
	});

	it("waits for controlled verification before accepting a Handoff", async () => {
		const factory = new FakeSubagentSessionFactory();
		let finishVerification: ((result: ControlledVerificationResult) => void) | undefined;
		const verificationRunner: ControlledVerificationRunner = () =>
			new Promise((resolve) => {
				finishVerification = resolve;
			});
		const subject = runtime(factory, undefined, verificationRunner);
		const agent = await subject.spawn({
			...spawnInput(BUILTIN_AGENT_PROFILES.worker),
			verificationCommands: ["node verify.js"],
		});
		const session = factory.sessions[0]!;
		await subject.send(agent.id, "Implement and verify");
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
		});
		session.complete(subagentHandoff({ changedFiles: ["src/index.ts"] }));
		const completion = subject.wait(agent.id);
		let settled = false;
		void completion.then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(finishVerification).toBeDefined());
		await Promise.resolve();
		expect(settled).toBe(false);

		finishVerification?.({ exitCode: 0, output: "passed", timedOut: false });
		await expect(completion).resolves.toMatchObject({ status: "completed" });
	});

	it("finalizes a verified Worker at the Session deadline instead of discarding its patch", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn({
			...spawnInput(BUILTIN_AGENT_PROFILES.worker),
			verificationCommands: ["node verify.js"],
		});
		const session = factory.sessions[0]!;
		const send = subject.send(agent.id, "Implement and verify");
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
		await vi.waitFor(() => expect(session.steerCalls).toHaveLength(1));
		expect(session.steerCalls[0]).toContain("Return the complete structured Handoff now");
		session.fail(new Error("Timeout waiting for agent to become idle"));
		await send;

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "completed",
			handoff: {
				conclusion: expect.stringContaining("required verification passed"),
				changedFiles: ["src/index.ts"],
				verificationSummary: [expect.stringContaining("node verify.js: passed")],
				risks: [expect.stringContaining("deadline")],
			},
		});
	});

	it("does not reuse a successful verification after a later code change", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn({
			...spawnInput(BUILTIN_AGENT_PROFILES.worker),
			verificationCommands: ["node verify.js"],
		});
		const session = factory.sessions[0]!;
		const send = subject.send(agent.id, "Implement and verify");
		for (const [toolCallId, toolName] of [
			["edit-1", "edit"],
			["verify-1", "bash"],
		] as const) {
			session.emit({
				type: "tool_execution_start",
				toolCallId,
				toolName,
				args: toolName === "bash" ? { command: "node verify.js" } : { path: "src/index.ts" },
			});
			session.emit({
				type: "tool_execution_end",
				toolCallId,
				toolName,
				isError: false,
				result: toolName === "bash" ? "verification passed" : undefined,
			});
		}
		await vi.waitFor(() => expect(session.steerCalls).toHaveLength(1));
		session.emit({
			type: "tool_execution_start",
			toolCallId: "edit-2",
			toolName: "edit",
			args: { path: "src/index.ts" },
		});
		session.emit({
			type: "tool_execution_end",
			toolCallId: "edit-2",
			toolName: "edit",
			isError: false,
		});
		session.fail(new Error("Timeout waiting for agent to become idle"));
		await send;

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "failed",
			errorCode: "subagent.duration_exceeded",
		});
	});

	it("steers a Reviewer to return its verdict after five turns", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn(spawnInput(BUILTIN_AGENT_PROFILES.reviewer));
		const session = factory.sessions[0]!;
		await subject.send(agent.id, "Review the scoped diff");
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

		for (let index = 0; index < 4; index++) session.emit(turn);
		expect(session.steerCalls).toHaveLength(0);
		session.emit(turn);
		await vi.waitFor(() => expect(session.steerCalls).toHaveLength(1));
		expect(session.steerCalls[0]).toContain("review:passed or review:failed");
		expect(subject.get(agent.id)?.status).toBe("running");
		session.emit(turn);
		expect(session.steerCalls).toHaveLength(1);
		session.complete(subagentHandoff({ verificationSummary: ["review:passed"] }));
		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "completed",
			handoff: { verificationSummary: ["review:passed"] },
		});
		await subject.dispose();
	});
	it("steers a Worker before escalating persistent no progress at twenty turns", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn(spawnInput(BUILTIN_AGENT_PROFILES.worker));
		const session = factory.sessions[0]!;
		await subject.send(agent.id, "Implement the assigned change");
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

		for (let index = 0; index < 6; index++) session.emit(turn);
		await vi.waitFor(() => expect(session.steerCalls).toHaveLength(1));
		expect(session.steerCalls[0]).toContain("Stop planning and broad exploration");
		for (let index = 0; index < 14; index++) session.emit(turn);

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "interrupted",
			errorCode: "subagent.no_progress",
			error: expect.stringContaining("No implementation progress after 20 Worker turns"),
		});
	});

	it("gives the strong retry forty turns to begin implementation", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory, routingGateway());
		const first = await subject.spawn(spawnInput(BUILTIN_AGENT_PROFILES.worker));
		await subject.send(first.id, "Implement the assigned change");
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
		for (let index = 0; index < 20; index++) factory.sessions[0]!.emit(turn);
		await expect(subject.wait(first.id)).resolves.toMatchObject({
			errorCode: "subagent.no_progress",
		});

		const retry = await subject.retry(first.id, {
			attemptId: "attempt-2",
			autoStart: false,
			failureReason: "No implementation progress",
			modelEscalationReason: "no_progress",
		});
		await subject.send(retry.id, "Continue the implementation now");
		for (let index = 0; index < 12; index++) factory.sessions[1]!.emit(turn);
		await vi.waitFor(() => expect(factory.sessions[1]!.steerCalls).toHaveLength(1));
		expect(subject.get(retry.id)?.status).toBe("running");

		for (let index = 0; index < 28; index++) factory.sessions[1]!.emit(turn);
		await expect(subject.wait(retry.id)).resolves.toMatchObject({
			status: "interrupted",
			errorCode: "subagent.no_progress",
			error: expect.stringContaining("No implementation progress after 40 Worker turns"),
		});
	});

	it("steers and stops a Worker by wall-clock time when turns are slow", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			workerNoProgressSteerMs: 10,
			workerNoProgressStopMs: 30,
		});
		const agent = await subject.spawn(spawnInput(BUILTIN_AGENT_PROFILES.worker));
		const session = factory.sessions[0]!;
		await subject.send(agent.id, "Implement the assigned change");

		await vi.waitFor(() => expect(session.steerCalls).toHaveLength(1));
		expect(session.steerCalls[0]).toContain("Stop planning and broad exploration");
		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "interrupted",
			errorCode: "subagent.no_progress",
			error: expect.stringContaining("No implementation progress after 30ms"),
		});
	});

	it("keeps no-progress monitoring active after a failed edit", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			workerNoProgressSteerMs: 10,
			workerNoProgressStopMs: 30,
		});
		const agent = await subject.spawn(spawnInput(BUILTIN_AGENT_PROFILES.worker));
		const session = factory.sessions[0]!;
		await subject.send(agent.id, "Implement the assigned change");
		session.emit({
			type: "tool_execution_start",
			toolCallId: "edit-failed",
			toolName: "edit",
			args: { path: "src/index.ts" },
		});
		session.emit({
			type: "tool_execution_end",
			toolCallId: "edit-failed",
			toolName: "edit",
			isError: true,
		});

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "interrupted",
			errorCode: "subagent.no_progress",
		});
	});

	it("does not retain token or tool update floods as progress events", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn(spawnInput());
		await subject.send(agent.id, "Inspect");
		const session = factory.sessions[0]!;

		for (let index = 0; index < 1_000; index++) {
			session.emit({ type: "message_update" });
			session.emit({ type: "tool_execution_update" });
		}
		session.emit({ type: "auto_retry_start" });

		expect(subject.events(agent.id).filter(({ type }) => type === "progress")).toEqual([
			expect.objectContaining({ message: "Model retry started" }),
		]);
		session.complete(SUBAGENT_HANDOFF);
		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "completed",
		});
	});

	it("fails invalid Handoff output and creates a distinct retry Agent", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory, routingGateway());
		const agent = await subject.spawn(spawnInput());
		factory.sessions[0]!.repairOutput = '{"conclusion":""}';
		factory.sessions[0]!.repairCompletesSynchronously = true;
		await subject.send(agent.id, "Inspect");
		factory.sessions[0]?.complete('{"conclusion":""}');

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "failed",
			error: expect.stringContaining("conclusion"),
		});
		const retried = await subject.retry(agent.id, {
			attemptId: "attempt-2",
			autoStart: false,
			failureReason: "Invalid Handoff",
		});
		expect(retried).toMatchObject({
			id: "agent-3",
			attemptId: "attempt-2",
			retryCount: 1,
			retryOfAgentId: agent.id,
			modelRoute: {
				tier: "strong",
				modelName: "test/strong",
				reasonCode: "model.no_progress_escalated_strong",
			},
			recoveryContext: {
				originalPrompt: "Inspect",
				reason: "Invalid Handoff",
			},
		});
		await expect(
			subject.retry(agent.id, {
				attemptId: "attempt-3",
				autoStart: false,
			}),
		).rejects.toBeInstanceOf(RuntimePolicyError);
	});

	it("repairs an invalid Planner Lite Handoff in the same Session", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn(spawnInput(BUILTIN_AGENT_PROFILES.planner_lite));
		const session = factory.sessions[0]!;
		session.repairOutput = SUBAGENT_HANDOFF;
		session.repairUsage = {
			...ZERO_USAGE,
			inputTokens: 20,
			outputTokens: 10,
			turns: 2,
		};
		session.repairCompletesSynchronously = true;

		await subject.send(agent.id, "Create the execution contract");
		session.complete('{"summary":"Contract prepared"}', {
			...ZERO_USAGE,
			inputTokens: 10,
			outputTokens: 5,
			turns: 1,
		});

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "completed",
			handoff: { conclusion: "Inspection completed" },
			usage: { inputTokens: 20, outputTokens: 10, turns: 2 },
		});
		expect(session.promptCalls).toHaveLength(2);
		expect(session.promptCalls[1]).toContain("Format validation failed");
		expect(subject.get(agent.id)).toMatchObject({
			status: "idle",
			handoffId: expect.any(String),
		});
		expect(subject.list()).toHaveLength(1);
	});

	it("repairs an invalid Reviewer Handoff in the same Session", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn(spawnInput(BUILTIN_AGENT_PROFILES.reviewer));
		const session = factory.sessions[0]!;
		session.repairOutput = subagentHandoff({
			conclusion: "Review completed",
			verificationSummary: ["Reviewed the implementation"],
		});
		session.repairUsage = {
			...ZERO_USAGE,
			inputTokens: 20,
			outputTokens: 10,
			turns: 2,
		};
		session.repairCompletesSynchronously = true;

		await subject.send(agent.id, "Review the implementation");
		session.complete('{"conclusion":"Review completed",}', {
			...ZERO_USAGE,
			inputTokens: 10,
			outputTokens: 5,
			turns: 1,
		});

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "completed",
			handoff: {
				conclusion: "Review completed",
				verificationSummary: ["Reviewed the implementation"],
			},
			usage: { turns: 2 },
		});
		expect(session.promptCalls).toHaveLength(2);
		expect(session.promptCalls[1]).toContain("Format validation failed");
		expect(subject.get(agent.id)).toMatchObject({
			status: "idle",
			handoffId: expect.any(String),
		});
		expect(subject.list()).toHaveLength(1);
	});

	it("interrupts a running Agent and enforces parent depth", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const parent = await subject.spawn({
			...spawnInput(),
			profile: BUILTIN_AGENT_PROFILES.worker,
			parentBudget: { maxAgentDepth: 0 },
			workflowBudget: { maxConcurrentAgents: 2, maxAgentDepth: 2 },
		});
		await expect(
			subject.spawn({
				...spawnInput(),
				attemptId: "attempt-child",
				parentAgentId: parent.id,
			}),
		).rejects.toBeInstanceOf(RuntimePolicyError);

		await subject.send(parent.id, "Work");
		const [interrupted, duplicate] = await Promise.all([subject.interrupt(parent.id), subject.interrupt(parent.id)]);
		expect(interrupted.status).toBe("interrupted");
		expect(duplicate).toEqual(interrupted);
		expect(factory.sessions[0]?.abortCalls).toBe(1);
	});

	it("compiles path-scoped RPC permissions into the enforced child policy", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn({
			...spawnInput(),
			parentPermission: {
				...FULL_PERMISSION_SET,
				allowedPaths: ["src"],
			},
		});

		expect(agent.enforcementPlan?.filesystem.readableRoots[0]).toMatch(/[\\/]repo[\\/]src$/);
		expect(factory.sessions[0]?.config.environment?.PI_SUBAGENT_PATH_POLICY).toContain("repo");
	});

	it("rejects an unavailable backend before creating an Agent", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);

		await expect(
			subject.spawn({
				...spawnInput(),
				backend: "in-process",
			}),
		).rejects.toMatchObject({
			code: "subagent.backend_unsupported",
		});
		expect(subject.list()).toHaveLength(0);
		expect(factory.sessions).toHaveLength(0);
	});

	it("routes eligible read-only Agents to the in-process Backend without weakening safety", async () => {
		const rpcFactory = new FakeSubagentSessionFactory();
		const inProcessFactory = new FakeSubagentSessionFactory();
		const subject = new SubagentRuntime({
			sessionFactory: rpcFactory,
			inProcessSessionFactory: inProcessFactory,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const agent = await subject.spawn({ ...spawnInput(), backend: "auto" });

		expect(agent).toMatchObject({
			backend: "in-process",
			backendReason: "Auto-selected for a statically safe read-only Agent",
			backendReasonCode: "backend.auto_safe_in_process",
			creationReasonCode: "agent.exploration_requested",
		});
		expect(subject.events(agent.id)[0]).toMatchObject({
			eventName: "subagent_created",
			reasonCodes: ["agent.exploration_requested", "backend.auto_safe_in_process"],
		});
		expect(rpcFactory.sessions).toHaveLength(0);
		expect(inProcessFactory.sessions).toHaveLength(1);
		await expect(
			subject.spawn({
				...spawnInput(BUILTIN_AGENT_PROFILES.worker),
				taskId: "task-2",
				attemptId: "attempt-2",
				backend: "in-process",
			}),
		).rejects.toMatchObject({ code: "subagent.in_process_unsafe" });
	});

	it("applies the configured default Backend when spawn does not select one", async () => {
		const rpcFactory = new FakeSubagentSessionFactory();
		const inProcessFactory = new FakeSubagentSessionFactory();
		const subject = new SubagentRuntime({
			sessionFactory: rpcFactory,
			inProcessSessionFactory: inProcessFactory,
			defaultBackend: "auto",
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});

		const agent = await subject.spawn(spawnInput());

		expect(agent).toMatchObject({
			backend: "in-process",
			backendReasonCode: "backend.auto_safe_in_process",
		});
		expect(rpcFactory.sessions).toHaveLength(0);
		expect(inProcessFactory.sessions).toHaveLength(1);
		await subject.dispose();
	});

	it("retains a prepared Workspace through completion and releases it with the Session", async () => {
		const factory = new FakeSubagentSessionFactory();
		const released: string[] = [];
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			workspaceProvider: {
				prepare: async ({ agentId }) => ({
					id: `workspace:${agentId}`,
					path: "C:/isolated",
				}),
				release: async ({ id }) => {
					released.push(id);
				},
			},
		});
		const agent = await subject.spawn(spawnInput());
		expect(agent.workspace).toEqual({
			id: `workspace:${agent.id}`,
			path: "C:/isolated",
		});
		expect(factory.sessions[0]?.config.cwd).toBe("C:/isolated");

		await subject.send(agent.id, "Inspect");
		factory.sessions[0]?.complete(SUBAGENT_HANDOFF);
		await subject.wait(agent.id);
		expect(released).toEqual([]);

		await subject.release(agent.id);
		expect(released).toEqual([`workspace:${agent.id}`]);
	});

	it("recovers released Agent state and Transcript from the parent Session", async () => {
		const sessionManager = SessionManager.inMemory("C:/repo");
		const persistence = new SessionSubagentPersistence(sessionManager);
		const factory = new FakeSubagentSessionFactory();
		const first = new SubagentRuntime({
			sessionFactory: factory,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
			createId: (() => {
				let sequence = 0;
				return (kind: "agent" | "handoff") => `${kind}-${++sequence}`;
			})(),
		});
		const agent = await first.spawn(spawnInput());
		await first.send(agent.id, "Inspect persisted state");
		factory.sessions[0]?.complete(SUBAGENT_HANDOFF);
		const completed = await first.wait(agent.id);
		await first.dispose();

		const recovered = new SubagentRuntime({
			sessionFactory: new FakeSubagentSessionFactory(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
		});

		expect(recovered.get(agent.id)).toMatchObject({
			status: "idle",
			handoffId: completed.handoff?.id,
			sessionReleasedAt: expect.any(String),
		});
		expect(recovered.getTranscript(agent.id).entries.map(({ type }) => type)).toEqual(["prompt", "assistant"]);
		expect(await recovered.wait(agent.id)).toMatchObject({
			status: "completed",
			handoff: { conclusion: "Inspection completed" },
		});
	});

	it("persists every concurrent Handoff before releasing completed Agents", async () => {
		const sessionManager = SessionManager.inMemory("C:/repo");
		const persistence = new SessionSubagentPersistence(sessionManager);
		const factory = new FakeSubagentSessionFactory();
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
		});
		const agents = await Promise.all(
			["task-1", "task-2", "task-3"].map((taskId, index) =>
				subject.spawn({
					...spawnInput(),
					taskId,
					attemptId: `attempt-${index + 1}`,
					parentBudget: {
						maxConcurrentAgents: 3,
						maxAgentDepth: 2,
						maxRetries: 1,
					},
					workflowBudget: {
						maxConcurrentAgents: 3,
						maxAgentDepth: 2,
						maxRetries: 1,
					},
				}),
			),
		);
		await Promise.all(agents.map((agent) => subject.send(agent.id, "Inspect")));
		factory.sessions.forEach((session) => {
			session.complete(SUBAGENT_HANDOFF);
		});
		await Promise.all(agents.map((agent) => subject.wait(agent.id)));
		await Promise.all([subject.dispose(), subject.dispose()]);

		const handoffs = persistence
			.load()
			.flatMap((record) =>
				record.kind === "checkpoint"
					? record.checkpoint.handoffs
					: record.kind === "state" && record.handoff
						? [record.handoff]
						: [],
			);
		expect(new Set(handoffs.map(({ id }) => id)).size).toBe(3);
	});

	it("cascades Workflow cancellation to every live Agent", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const first = await subject.spawn(spawnInput());
		const second = await subject.spawn({
			...spawnInput(),
			taskId: "task-2",
			attemptId: "attempt-2",
		});
		await Promise.all([subject.send(first.id, "Inspect first"), subject.send(second.id, "Inspect second")]);

		const results = await subject.cancelWorkflow("workflow-1", "Workflow cancelled");

		expect(results.map(({ status }) => status)).toEqual(["interrupted", "interrupted"]);
		expect(factory.sessions.map(({ abortCalls }) => abortCalls)).toEqual([1, 1]);
		expect(subject.list("workflow-1").map(({ status }) => status)).toEqual(["interrupted", "interrupted"]);
	});

	it("applies the parent Workflow budget across parallel Agent usage", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const limitedInput = {
			...spawnInput(),
			parentBudget: { maxInputTokens: 30, maxConcurrentAgents: 2 },
			workflowBudget: { maxInputTokens: 30, maxConcurrentAgents: 2 },
			taskBudget: { maxInputTokens: 30 },
		};
		const first = await subject.spawn(limitedInput);
		const second = await subject.spawn({
			...limitedInput,
			taskId: "task-2",
			attemptId: "attempt-2",
		});
		await Promise.all([subject.send(first.id, "Inspect first"), subject.send(second.id, "Inspect second")]);
		factory.sessions[0]?.complete(SUBAGENT_HANDOFF, {
			...ZERO_USAGE,
			inputTokens: 20,
			turns: 1,
		});
		expect(await subject.wait(first.id)).toMatchObject({ status: "completed" });
		factory.sessions[1]?.complete(SUBAGENT_HANDOFF, {
			...ZERO_USAGE,
			inputTokens: 20,
			turns: 1,
		});

		expect(await subject.wait(second.id)).toMatchObject({
			status: "failed",
			error: expect.stringContaining("maxInputTokens"),
		});
	});

	it("does not widen an established Workflow permission for later Agents", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const readOnlyWorkflow = {
			...FULL_PERMISSION_SET,
			write: false,
			executeCommands: false,
			network: false,
		};
		await subject.spawn({
			...spawnInput(),
			workflowPermission: readOnlyWorkflow,
		});
		await subject.spawn({
			...spawnInput(BUILTIN_AGENT_PROFILES.worker),
			taskId: "task-2",
			attemptId: "attempt-2",
			workflowPermission: FULL_PERMISSION_SET,
		});

		expect(factory.sessions[1]?.config.toolNames).toEqual(["read", "grep", "find", "ls"]);
	});

	it("interrupts at a streamed turn boundary when a hard budget is reached", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn({
			...spawnInput(),
			parentBudget: { maxTurns: 1 },
			workflowBudget: { maxTurns: 1 },
			taskBudget: { maxTurns: 1 },
		});
		await subject.send(agent.id, "Inspect");
		factory.sessions[0]?.emit({
			type: "turn_end",
			message: {
				role: "assistant",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { total: 0.01 },
				},
			},
		});

		expect(await subject.wait(agent.id)).toMatchObject({
			status: "interrupted",
			error: "Budget exhausted: maxTurns",
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				turns: 1,
				cost: 0.01,
			},
		});
		expect(factory.sessions[0]?.abortCalls).toBe(1);
	});
});
