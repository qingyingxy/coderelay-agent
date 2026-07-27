import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_PROFILES,
	FULL_PERMISSION_SET,
	RuntimePolicyError,
	SubagentRuntime,
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

function runtime(factory: FakeSubagentSessionFactory): SubagentRuntime {
	let sequence = 0;
	return new SubagentRuntime({
		sessionFactory: factory,
		writerLeaseRegistry: new WriterLeaseRegistry(),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
		createId: (kind) => `${kind}-${++sequence}`,
		now: () => 100,
	});
}

describe("SubagentRuntime", () => {
	it("creates an isolated read-only Session and completes with a validated Handoff", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn(spawnInput());

		expect(agent).toMatchObject({
			id: "agent-1",
			sessionId: "session-1",
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
		expect(subject.registry.get(agent.id)).toMatchObject({
			status: "idle",
			handoffId: "handoff-2",
		});
		await expect(subject.send(agent.id, "Run again")).rejects.toMatchObject({
			code: "subagent.run_terminal",
		});
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
		expect(factory.sessions[0]?.config.toolNames).not.toContain("bash");

		await subject.send(agent.id, "Implement the Task");
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
		expect(leaseRegistry.get("C:/repo")).toBeUndefined();
	});

	it("fails invalid Handoff output and creates a distinct retry Agent", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		const agent = await subject.spawn(spawnInput());
		await subject.send(agent.id, "Inspect");
		factory.sessions[0]?.complete('{"conclusion":""}');

		await expect(subject.wait(agent.id)).resolves.toMatchObject({
			status: "failed",
			error: expect.stringContaining("conclusion"),
		});
		const retried = await subject.retry(agent.id, {
			attemptId: "attempt-2",
			autoStart: false,
		});
		expect(retried).toMatchObject({
			id: "agent-3",
			attemptId: "attempt-2",
			retryCount: 1,
			retryOfAgentId: agent.id,
		});
		await expect(
			subject.retry(agent.id, {
				attemptId: "attempt-3",
				autoStart: false,
			}),
		).rejects.toBeInstanceOf(RuntimePolicyError);
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

	it("rejects path-scoped RPC permissions instead of silently widening them", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subject = runtime(factory);
		await expect(
			subject.spawn({
				...spawnInput(),
				parentPermission: {
					...FULL_PERMISSION_SET,
					allowedPaths: ["src"],
				},
			}),
		).rejects.toMatchObject({
			code: "runtime_policy.path_scope_unsupported",
		});
		expect(factory.sessions).toHaveLength(0);
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
		factory.sessions[0]?.complete(SUBAGENT_HANDOFF, { ...ZERO_USAGE, inputTokens: 20, turns: 1 });
		expect(await subject.wait(first.id)).toMatchObject({ status: "completed" });
		factory.sessions[1]?.complete(SUBAGENT_HANDOFF, { ...ZERO_USAGE, inputTokens: 20, turns: 1 });

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
		});
		expect(factory.sessions[0]?.abortCalls).toBe(1);
	});
});
