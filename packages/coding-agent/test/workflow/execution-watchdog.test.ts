import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentReadonlyReviewer } from "../../src/core/delivery/reviewer-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { ExecutionWatchdog, LONG_TASK_WATCHDOG } from "../../src/core/workflow/execution-watchdog.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import {
	BUILTIN_AGENT_PROFILES,
	FULL_PERMISSION_SET,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { ZERO_USAGE } from "./fixtures.ts";
import { FakeSubagentSessionFactory, SUBAGENT_HANDOFF } from "./subagent-fixtures.ts";

afterEach(() => vi.useRealTimers());

function tool(emit: (event: unknown) => void, path: string, result = "unchanged", name = "read") {
	emit({ type: "tool_execution_start", toolCallId: "call", toolName: name, args: { path } });
	emit({ type: "tool_execution_end", toolCallId: "call", result, isError: false });
	emit({ type: "turn_end" });
}

describe("execution watchdog", () => {
	it("dispatches an approved plan and records a long Worker result without reintroducing task caps", async () => {
		vi.useFakeTimers();
		const factory = new FakeSubagentSessionFactory();
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			executionWatchdog: LONG_TASK_WATCHDOG,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		try {
			const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
				workflowId: "plan",
				rootTaskId: "root",
				planId: "p",
				budget: { maxRetries: 0, maxConcurrentAgents: 1 },
				request: { text: "Implement fix", cwd: "C:/repo", attachments: [] },
			});
			plan.submit({
				goal: "Implement fix",
				assumptions: [],
				risks: [],
				verificationRequirements: [],
				steps: [
					{
						id: "implement",
						kind: "agent",
						requiredAgentRole: "worker",
						title: "Implement",
						description: "Implement fix",
						dependsOn: [],
						fileIntents: [{ path: "src/index.ts", action: "modify", reason: "Fix" }],
						verificationRequirementIds: [],
					},
				],
			});
			plan.approve();
			const [dispatch] = await plan.startReadySubagents(subject, 1);
			expect(dispatch?.agent.budget.maxDurationMs).toBeUndefined();
			for (let index = 0; index < 3; index++) {
				await vi.advanceTimersByTimeAsync(20 * 60_000);
				tool((event) => factory.sessions[0]!.emit(event), `src/file-${index}`);
			}
			factory.sessions[0]!.complete(SUBAGENT_HANDOFF, { ...ZERO_USAGE, cost: 3 });
			expect(await dispatch!.completion).toMatchObject({ status: "completed", usage: { cost: 3 } });
			expect(plan.tasks.find((task) => task.sourcePlanStepId === "implement")?.status).toBe("succeeded");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await subject.dispose();
		}
	});
	it("does not call a broad second read pass a loop", () => {
		const stop = vi.fn();
		const monitor = new ExecutionWatchdog(LONG_TASK_WATCHDOG, stop);
		try {
			for (let pass = 0; pass < 2; pass++)
				for (let index = 0; index < 30; index++) tool((event) => monitor.observe(event), `file-${index}`);
			expect(stop).not.toHaveBeenCalled();
		} finally {
			monitor.dispose();
		}
	});

	it("does not retry a reviewer stopped by the watchdog", async () => {
		vi.useFakeTimers();
		const factory = new FakeSubagentSessionFactory();
		const subject = new SubagentRuntime({
			sessionFactory: factory,
			executionWatchdog: LONG_TASK_WATCHDOG,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		try {
			const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
				workflowId: "review",
				rootTaskId: "root",
				planId: "p",
				budget: { maxRetries: 1 },
				request: { text: "Original task", cwd: "C:/repo", attachments: [] },
			});
			const review = new SubagentReadonlyReviewer(subject).review({
				workflow: plan.workflow,
				rootTask: plan.tasks[0]!,
				diff: { files: [], changedFiles: [], summary: "Review", evidenceRefs: [] },
			});
			await vi.waitFor(() => expect(subject.list()[0]?.status).toBe("running"));
			await vi.advanceTimersByTimeAsync(LONG_TASK_WATCHDOG.inactivityMs + 1);
			expect(await review).toMatchObject({ status: "failed", failureKind: "infrastructure" });
			expect(factory.sessions).toHaveLength(1);
			expect(subject.list()[0]?.sessionReleasedAt).toBeDefined();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await subject.dispose();
		}
	});
	it("allows hours of distinct read-only results, then stops after 30 minutes without a response", async () => {
		vi.useFakeTimers();
		const stop = vi.fn();
		const monitor = new ExecutionWatchdog(LONG_TASK_WATCHDOG, stop);
		for (let index = 0; index < 12; index++) {
			await vi.advanceTimersByTimeAsync(20 * 60_000);
			tool((event) => monitor.observe(event), `file-${index}`);
		}
		expect(stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
		expect(stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "inactivity" }));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("detects an alternating loop even after an edit, and saves its fingerprint", () => {
		vi.useFakeTimers();
		const stop = vi.fn();
		const monitor = new ExecutionWatchdog(LONG_TASK_WATCHDOG, stop);
		tool((event) => monitor.observe(event), "source", "edited", "edit");
		for (let index = 0; index < 14; index++) tool((event) => monitor.observe(event), `file-${index % 2}`);
		expect(stop).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				kind: "repeated_results",
				repeatedResults: 12,
				lastFingerprint: expect.any(String),
			}),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resets the repetition counter on new evidence and ignores heartbeat metadata", async () => {
		vi.useFakeTimers();
		const stop = vi.fn();
		const monitor = new ExecutionWatchdog(LONG_TASK_WATCHDOG, stop);
		for (let index = 0; index < 40; index++)
			tool((event) => monitor.observe(event), "same-file", String(Math.floor(index / 4)));
		expect(stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(29 * 60_000);
		monitor.observe({ type: "heartbeat" });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(stop).toHaveBeenCalledOnce();
	});

	it.each(["worker", "reviewer", "planner"] as const)(
		"%s keeps full cost and completes beyond old caps without forced steering",
		async (role) => {
			vi.useFakeTimers();
			const factory = new FakeSubagentSessionFactory();
			const subject = new SubagentRuntime({
				sessionFactory: factory,
				executionWatchdog: LONG_TASK_WATCHDOG,
				maxAgentDurationMs: 240_000,
				writerLeaseRegistry: new WriterLeaseRegistry(),
				runtimeRegistry: new WorkflowRuntimeRegistry(),
			});
			try {
				const agent = await subject.spawn({
					workflowId: "w",
					taskId: "t",
					attemptId: "a",
					cwd: "C:/repo",
					profile: BUILTIN_AGENT_PROFILES[role],
					parentPermission: FULL_PERMISSION_SET,
					workflowPermission: FULL_PERMISSION_SET,
					taskPermission: FULL_PERMISSION_SET,
					parentBudget: { maxCost: 2 },
					workflowBudget: { maxDurationMs: 900_000, maxConcurrentAgents: 1 },
					taskBudget: { maxDurationMs: 240_000, maxTurns: 5, maxRetries: 1 },
					workflowDeadlineAtMs: Date.now() + 900_000,
				});
				expect(agent.budget).toMatchObject({ maxRetries: 1, maxConcurrentAgents: 0 });
				expect(agent.budget.maxDurationMs).toBeUndefined();
				expect(agent.budget.maxCost).toBeUndefined();
				expect(agent.budget.maxTurns).toBeUndefined();
				const session = factory.sessions[0]!;
				const wait = vi.spyOn(session, "waitForIdle");
				await subject.send(agent.id, "Perform the assigned work");
				for (let index = 0; index < 60; index++) {
					await vi.advanceTimersByTimeAsync(60_000);
					tool((event) => session.emit(event), `source-${index}`);
					session.emit({
						type: "turn_end",
						message: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } },
					});
				}
				expect(subject.get(agent.id)?.status).toBe("running");
				expect(session.steerCalls).toEqual([]);
				expect(wait).toHaveBeenCalledWith(0);
				session.complete(SUBAGENT_HANDOFF, { ...ZERO_USAGE, cost: 6, turns: 60 });
				const result = await subject.wait(agent.id);
				expect(result.status).toBe("completed");
				expect(result.usage.cost).toBeGreaterThanOrEqual(6);
				expect(result.usage.durationMs).toBe(3_600_000);
				await subject.release(agent.id);
				expect(subject.get(agent.id)?.sessionReleasedAt).toBeDefined();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				await subject.dispose();
			}
		},
	);

	it.each(["inactivity", "repeated_results"])(
		"%s interrupts the Worker and releases its writer slot",
		async (kind) => {
			vi.useFakeTimers();
			const factory = new FakeSubagentSessionFactory();
			const subject = new SubagentRuntime({
				sessionFactory: factory,
				maxAgents: 1,
				executionWatchdog: LONG_TASK_WATCHDOG,
				writerLeaseRegistry: new WriterLeaseRegistry(),
				runtimeRegistry: new WorkflowRuntimeRegistry(),
			});
			try {
				const agent = await subject.spawn({
					workflowId: "w",
					taskId: "t",
					attemptId: "a",
					cwd: "C:/repo",
					profile: BUILTIN_AGENT_PROFILES.worker,
					parentPermission: FULL_PERMISSION_SET,
					workflowPermission: FULL_PERMISSION_SET,
					taskPermission: FULL_PERMISSION_SET,
					parentBudget: {},
					workflowBudget: {},
					taskBudget: {},
				});
				await subject.send(agent.id, "Work");
				if (kind === "inactivity") await vi.advanceTimersByTimeAsync(LONG_TASK_WATCHDOG.inactivityMs);
				else
					for (let index = 0; index < 13; index++) tool((event) => factory.sessions[0]!.emit(event), "same-file");
				const result = await subject.wait(agent.id);
				expect(result.status).toBe("interrupted");
				expect(result.error).toContain(kind);
				expect(subject.get(agent.id)?.sessionReleasedAt).toBeDefined();
				expect(subject.availableSlots("w")).toBe(1);
				expect(factory.sessions[0]!.listeners.size).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				await subject.dispose();
			}
		},
	);
});
