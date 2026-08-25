import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_PROFILES,
	CurrentWorkspaceProvider,
	FULL_PERMISSION_SET,
	SubagentRuntime,
	type SubagentSessionConfig,
	type SubagentSessionFactory,
} from "../../src/index.ts";
import { FakeSubagentSession, FakeSubagentSessionFactory } from "./subagent-fixtures.ts";

class HangingPromptSession extends FakeSubagentSession {
	override prompt(_message: string): Promise<void> {
		return new Promise(() => undefined);
	}

	override waitForIdle(): Promise<void> {
		return new Promise(() => undefined);
	}
}

class HangingPromptSessionFactory implements SubagentSessionFactory {
	create(config: SubagentSessionConfig): HangingPromptSession {
		return new HangingPromptSession(config, "hanging-session");
	}
}

class HangingStartSession extends FakeSubagentSession {
	override start(): Promise<void> {
		return new Promise(() => undefined);
	}
}

class HangingStartSessionFactory implements SubagentSessionFactory {
	create(config: SubagentSessionConfig): HangingStartSession {
		return new HangingStartSession(config, "hanging-start-session");
	}
}

describe("SubagentRuntime duration limit", () => {
	it("clamps profile duration for externally budgeted evaluations", async () => {
		const sessions = new FakeSubagentSessionFactory();
		const runtime = new SubagentRuntime({
			sessionFactory: sessions,
			maxAgentDurationMs: 60_000,
			workspaceProvider: new CurrentWorkspaceProvider(),
		});
		try {
			const agent = await runtime.spawn({
				workflowId: "workflow-budget",
				taskId: "task-budget",
				attemptId: "attempt-budget",
				cwd: process.cwd(),
				profile: BUILTIN_AGENT_PROFILES.worker,
				parentPermission: FULL_PERMISSION_SET,
				workflowPermission: FULL_PERMISSION_SET,
				taskPermission: FULL_PERMISSION_SET,
				parentBudget: {},
				workflowBudget: {},
				taskBudget: {},
			});

			expect(agent.budget.maxDurationMs).toBe(60_000);
			expect(sessions.sessions[0]?.config.budget.maxDurationMs).toBe(60_000);
		} finally {
			await runtime.dispose();
		}
	});

	it("clamps an Agent to the remaining Workflow wall-clock deadline", async () => {
		const sessions = new FakeSubagentSessionFactory();
		const runtime = new SubagentRuntime({
			sessionFactory: sessions,
			workspaceProvider: new CurrentWorkspaceProvider(),
		});
		try {
			const agent = await runtime.spawn({
				workflowId: "workflow-deadline",
				taskId: "task-deadline",
				attemptId: "attempt-deadline",
				cwd: process.cwd(),
				profile: BUILTIN_AGENT_PROFILES.worker,
				parentPermission: FULL_PERMISSION_SET,
				workflowPermission: FULL_PERMISSION_SET,
				taskPermission: FULL_PERMISSION_SET,
				parentBudget: {},
				workflowBudget: {},
				taskBudget: {},
				workflowDeadlineAtMs: Date.now() + 10_000,
			});

			expect(agent.budget.maxDurationMs).toBeGreaterThan(0);
			expect(agent.budget.maxDurationMs).toBeLessThanOrEqual(10_000);
			expect(sessions.sessions[0]?.config.budget.maxDurationMs).toBe(agent.budget.maxDurationMs);
		} finally {
			await runtime.dispose();
		}
	});

	it("records an idle deadline failure while RPC prompt acceptance is still pending", async () => {
		const runtime = new SubagentRuntime({
			sessionFactory: new HangingPromptSessionFactory(),
			maxAgentDurationMs: 10,
			workspaceProvider: new CurrentWorkspaceProvider(),
		});
		try {
			const agent = await runtime.spawn({
				workflowId: "workflow-timeout",
				taskId: "task-timeout",
				attemptId: "attempt-timeout",
				cwd: process.cwd(),
				profile: BUILTIN_AGENT_PROFILES.explorer,
				parentPermission: FULL_PERMISSION_SET,
				workflowPermission: FULL_PERMISSION_SET,
				taskPermission: FULL_PERMISSION_SET,
				parentBudget: {},
				workflowBudget: {},
				taskBudget: {},
			});

			await expect(runtime.send(agent.id, "Inspect the repository")).resolves.toBeUndefined();
			await expect(runtime.wait(agent.id)).resolves.toMatchObject({
				status: "failed",
				errorCode: "subagent.duration_exceeded",
				error: expect.stringContaining("exceeded 10ms"),
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("enforces the duration limit during RPC startup", async () => {
		const runtime = new SubagentRuntime({
			sessionFactory: new HangingStartSessionFactory(),
			maxAgentDurationMs: 10,
			workspaceProvider: new CurrentWorkspaceProvider(),
		});
		try {
			await expect(
				runtime.spawn({
					workflowId: "workflow-start-timeout",
					taskId: "task-start-timeout",
					attemptId: "attempt-start-timeout",
					cwd: process.cwd(),
					profile: BUILTIN_AGENT_PROFILES.explorer,
					parentPermission: FULL_PERMISSION_SET,
					workflowPermission: FULL_PERMISSION_SET,
					taskPermission: FULL_PERMISSION_SET,
					parentBudget: {},
					workflowBudget: {},
					taskBudget: {},
				}),
			).rejects.toThrow("startup exceeded 10ms");
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects a new Agent after previous Agents exhaust the cumulative Workflow turns", async () => {
		const sessions = new FakeSubagentSessionFactory();
		const runtime = new SubagentRuntime({
			sessionFactory: sessions,
			workspaceProvider: new CurrentWorkspaceProvider(),
		});
		try {
			const input = {
				workflowId: "workflow-cumulative-turns",
				taskId: "task-first",
				attemptId: "attempt-first",
				cwd: process.cwd(),
				profile: BUILTIN_AGENT_PROFILES.explorer,
				parentPermission: FULL_PERMISSION_SET,
				workflowPermission: FULL_PERMISSION_SET,
				taskPermission: FULL_PERMISSION_SET,
				parentBudget: { maxTurns: 2 },
				workflowBudget: { maxTurns: 2 },
				taskBudget: { maxTurns: 2 },
			};
			const first = await runtime.spawn(input);
			await runtime.send(first.id, "Inspect the repository");
			sessions.sessions[0]?.complete(undefined, {
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0.001,
				turns: 2,
				durationMs: 1,
			});
			await runtime.wait(first.id);

			await expect(
				runtime.spawn({
					...input,
					taskId: "task-second",
					attemptId: "attempt-second",
				}),
			).rejects.toMatchObject({ code: "runtime_policy.budget_exhausted" });
		} finally {
			await runtime.dispose();
		}
	});
});
