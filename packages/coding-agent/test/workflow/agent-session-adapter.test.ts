import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	decideDirectPlanUpgrade,
	FULL_PERMISSION_SET,
	SessionWorkflowEventLog,
	startDirectAgentSessionWorkflow,
	type WorkflowAgentSession,
	WorkflowStore,
	WriterLeaseRegistry,
} from "../../src/core/workflow/index.ts";

const WORKFLOW_ID = "workflow-1";
const TASK_ID = "task-1";

function providerUsage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: cost,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
	};
}

class FakeAgentSession implements WorkflowAgentSession {
	readonly sessionManager = SessionManager.inMemory();
	readonly #listeners = new Set<AgentSessionEventListener>();
	abortCalls = 0;
	waitForIdleCalls = 0;
	/** Events emitted synchronously while abort() runs, mirroring a real settling run. */
	abortEmits: AgentSessionEvent[] = [];

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async abort(): Promise<void> {
		this.abortCalls++;
		for (const event of this.abortEmits) {
			this.emit(event);
		}
	}

	async waitForIdle(): Promise<void> {
		this.waitForIdleCalls++;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}
}

function start(session: FakeAgentSession, deferCompletion = false) {
	let nextId = 0;
	return startDirectAgentSessionWorkflow(
		session,
		{
			commandId: "start-command",
			workflowId: WORKFLOW_ID,
			rootTaskId: TASK_ID,
			request: {
				text: "Implement a CLI change",
				cwd: "C:/repo",
				attachments: [],
			},
		},
		{
			createId: (kind) => `${kind}-${++nextId}`,
			now: () => 100,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			deferCompletion,
		},
	);
}

function emitRun(
	session: FakeAgentSession,
	message: Extract<AgentMessage, { role: "assistant" }>,
	willRetry: boolean,
	settled = true,
): void {
	session.emit({ type: "message_end", message });
	session.emit({ type: "turn_end", message, toolResults: [] });
	session.emit({ type: "agent_end", messages: [message], willRetry });
	if (settled) {
		session.emit({ type: "agent_settled" });
	}
}

function replay(session: FakeAgentSession): WorkflowStore {
	const store = new WorkflowStore();
	store.replay(new SessionWorkflowEventLog(session.sessionManager).read());
	return store;
}

/** Events a real AgentSession emits while an in-flight run is aborted. */
function abortedSettlement(): AgentSessionEvent[] {
	return [
		{ type: "agent_end", messages: [fauxAssistantMessage("", { stopReason: "aborted" })], willRetry: false },
		{ type: "agent_settled" },
	];
}

function highRiskUpgradeDecision() {
	const decision = decideDirectPlanUpgrade(
		{
			complexity: "high",
			riskLevel: "high",
			confidence: "low",
			reason: "The change crosses security and storage boundaries",
		},
		"2026-07-26T00:00:00.000Z",
	);
	if (decision.action !== "upgrade_to_plan") {
		throw new Error("Expected the assessment to require a Plan upgrade");
	}
	return decision;
}

let toolCallSeq = 0;

function mutate(session: FakeAgentSession, toolName: string, path: string, isError: boolean): void {
	const toolCallId = `tool-${++toolCallSeq}`;
	session.emit({ type: "tool_execution_start", toolCallId, toolName, args: { path } });
	session.emit({ type: "tool_execution_end", toolCallId, toolName, result: { path }, isError });
}

describe("AgentSessionAdapter", () => {
	it("drives a successful AgentSession run through basic verification to completion", () => {
		const session = new FakeAgentSession();
		const adapter = start(session);

		expect(adapter.controller.getRootTask(WORKFLOW_ID)?.status).toBe("ready");
		session.emit({ type: "agent_start" });
		const runningTask = adapter.controller.getRootTask(WORKFLOW_ID);
		expect(runningTask?.status).toBe("running");
		expect(adapter.statusLine).toBe(
			"direct | executing | root: task-1 (running) | attempt: 1 | Budget: within limits",
		);
		expect(adapter.statusLines).toEqual(
			expect.arrayContaining([
				"direct | executing | root: task-1 (running) | attempt: 1 | Budget: within limits",
				expect.stringMatching(/^Writer Lease: held \| /),
			]),
		);

		emitRun(session, fauxAssistantMessage("Implemented"), false);

		const store = replay(session);
		const task = store.getTask(TASK_ID);
		const attempt = task?.currentAttemptId ? store.getAttempt(task.currentAttemptId) : undefined;
		expect(attempt).toMatchObject({
			number: 1,
			status: "succeeded",
			usage: {
				turns: 1,
			},
		});
		expect(task?.status).toBe("succeeded");
		const workflow = store.getWorkflow(WORKFLOW_ID);
		expect(workflow?.status).toBe("completed");
		expect(workflow?.result).toMatchObject({
			status: "completed",
			changedFiles: [],
			verificationIds: [task?.result?.verificationIds[0]],
		});
		const verificationId = task?.result?.verificationIds[0];
		const verification = verificationId ? store.getVerification(verificationId) : undefined;
		expect(verification?.status).toBe("passed");
		expect(verification?.evidenceRefs).toEqual([
			"review:not-configured",
			"test:not-configured",
			"build:not-configured",
		]);
		expect(adapter.finalReport).toMatchObject({
			status: "completed",
			statusLine: "direct | completed | root: task-1 | 1 task | 0 files | tests: not configured",
			task: {
				status: "succeeded",
			},
			attempts: [{ number: 1, status: "succeeded" }],
		});
		expect(adapter.statusLines?.[0]).toBe(
			"direct | completed | root: task-1 | 1 task | 0 files | tests: not configured",
		);

		adapter.dispose();
	});

	it("summarizes changed files from successful edit/write tools and ignores failures", () => {
		const session = new FakeAgentSession();
		const adapter = start(session);

		session.emit({ type: "agent_start" });
		mutate(session, "edit", "src/a.ts", false);
		mutate(session, "write", "src/b.ts", false);
		mutate(session, "edit", "src/a.ts", false); // duplicate stays deduped
		mutate(session, "write", "src/c.ts", true); // failed write is not claimed
		mutate(session, "read", "src/d.ts", false); // non-mutation tool ignored
		emitRun(session, fauxAssistantMessage("Done"), false);

		const store = replay(session);
		expect(store.getWorkflow(WORKFLOW_ID)?.result?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
		expect(store.getTask(TASK_ID)?.modifications).toEqual([
			expect.objectContaining({
				path: "src/a.ts",
				operation: "edit",
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				agentId: "main-agent",
			}),
			expect.objectContaining({
				path: "src/b.ts",
				operation: "write",
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				agentId: "main-agent",
			}),
			expect.objectContaining({
				path: "src/a.ts",
				operation: "edit",
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				agentId: "main-agent",
			}),
		]);

		adapter.dispose();
	});

	it("defers terminal completion until the delivery protocol passes", () => {
		const session = new FakeAgentSession();
		const adapter = start(session, true);

		session.emit({ type: "agent_start" });
		emitRun(session, fauxAssistantMessage("Implemented"), false);

		expect(adapter.hasDeferredCompletion).toBe(true);
		expect(adapter.controller.getRootTask(WORKFLOW_ID)?.status).toBe("verifying");
		expect(adapter.controller.getWorkflow(WORKFLOW_ID)?.status).toBe("executing");

		adapter.completeDeferredVerification({
			evidenceRefs: ["review:reviewer-handoff"],
		});

		expect(adapter.hasDeferredCompletion).toBe(false);
		expect(adapter.controller.getWorkflow(WORKFLOW_ID)?.status).toBe("completed");
		expect(adapter.controller.listVerifications(WORKFLOW_ID)[0]?.evidenceRefs).toContain("review:reviewer-handoff");
		adapter.dispose();
	});

	it("fails honestly when a required protocol stage fails before the main attempt", () => {
		const session = new FakeAgentSession();
		const adapter = start(session, true);

		adapter.failProtocol("Explorer did not produce a Handoff");

		expect(adapter.controller.listAttempts(TASK_ID)).toEqual([
			expect.objectContaining({
				status: "failed",
				failure: expect.objectContaining({
					code: "execution_protocol.failed",
				}),
			}),
		]);
		expect(adapter.controller.getRootTask(WORKFLOW_ID)?.status).toBe("failed");
		expect(adapter.controller.getWorkflow(WORKFLOW_ID)).toMatchObject({
			status: "failed",
			result: {
				reason: "Explorer did not produce a Handoff",
			},
		});
		adapter.dispose();
	});

	it("binds foreground writer delegations to the active Task and transfers the Writer Lease", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });

		expect(() =>
			adapter.bindDelegation({
				parentPermission: FULL_PERMISSION_SET,
				requiresWriter: true,
				runInBackground: true,
			}),
		).toThrow("Writer Subagents must run in the foreground");
		const binding = adapter.bindDelegation({
			parentPermission: FULL_PERMISSION_SET,
			requiresWriter: true,
			runInBackground: false,
		});
		expect(binding.input).toMatchObject({
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: "attempt-2",
		});
		expect(adapter.statusLines).toContain("Writer Lease: not held");

		await binding.settle?.({
			agentId: "agent-child",
			status: "completed",
			usage: {
				inputTokens: 7,
				outputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0.01,
				turns: 1,
				durationMs: 20,
			},
			modifications: [{ path: "src/delegated.ts", operation: "write", toolCallId: "child-tool" }],
		});
		expect(adapter.statusLines).toEqual(expect.arrayContaining([expect.stringMatching(/^Writer Lease: held \| /)]));

		emitRun(session, fauxAssistantMessage("Done"), false);
		const store = replay(session);
		expect(store.getWorkflow(WORKFLOW_ID)?.result).toMatchObject({
			changedFiles: ["src/delegated.ts"],
			usage: {
				inputTokens: 7,
				outputTokens: 3,
				turns: 2,
			},
		});
		expect(store.getTask(TASK_ID)?.modifications).toContainEqual(
			expect.objectContaining({
				path: "src/delegated.ts",
				agentId: "agent-child",
				attemptId: "attempt-2",
			}),
		);
		adapter.dispose();
	});

	it("creates a new Attempt after agent_end reports willRetry", () => {
		const session = new FakeAgentSession();
		const adapter = start(session);

		session.emit({ type: "agent_start" });
		emitRun(
			session,
			{
				...fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "overloaded_error",
				}),
				usage: providerUsage(10, 1, 0.01),
			},
			true,
			false,
		);
		expect(adapter.controller.getRootTask(WORKFLOW_ID)?.status).toBe("ready");

		session.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1,
			errorMessage: "overloaded_error",
			reasonCode: "retry.transient_error",
		});
		session.emit({ type: "agent_start" });
		emitRun(
			session,
			{
				...fauxAssistantMessage("Recovered"),
				usage: providerUsage(20, 2, 0.02),
			},
			false,
		);

		const store = replay(session);
		const attempts = store.listAttempts(TASK_ID);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toMatchObject({
			number: 1,
			status: "failed",
			failure: {
				retryable: true,
			},
		});
		expect(attempts[1]).toMatchObject({
			number: 2,
			status: "succeeded",
		});
		expect(store.getWorkflow(WORKFLOW_ID)?.status).toBe("completed");
		expect(store.getWorkflow(WORKFLOW_ID)?.result?.usage).toMatchObject({
			inputTokens: 30,
			outputTokens: 3,
			turns: 2,
		});
		expect(store.getWorkflow(WORKFLOW_ID)?.result?.usage.cost).toBeCloseTo(0.03);

		adapter.dispose();
	});

	it("fails the Workflow only after a non-retryable run settles", () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "invalid_api_key",
		});

		session.emit({ type: "agent_start" });
		emitRun(session, message, false, false);
		expect(adapter.controller.getWorkflow(WORKFLOW_ID)?.status).toBe("executing");
		session.emit({ type: "agent_settled" });

		const store = replay(session);
		expect(store.getAttempt(store.getTask(TASK_ID)?.currentAttemptId ?? "")).toMatchObject({
			status: "failed",
			failure: {
				message: "invalid_api_key",
				retryable: false,
			},
		});
		expect(store.getWorkflow(WORKFLOW_ID)).toMatchObject({
			status: "failed",
			result: {
				reason: "invalid_api_key",
			},
		});
		expect(adapter.finalReport).toMatchObject({
			status: "failed",
			failureReason: "invalid_api_key",
		});

		adapter.dispose();
	});

	it("cancels an in-flight run in two phases, waiting for idle before finalizing", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });
		session.abortEmits = abortedSettlement();

		expect(adapter.controller.getWorkflow(WORKFLOW_ID)?.status).toBe("executing");
		await adapter.cancel("User cancelled");

		// Cancellation stops the AgentSession and waits for it to return to idle.
		expect(session.abortCalls).toBe(1);
		expect(session.waitForIdleCalls).toBe(1);

		const store = replay(session);
		const task = store.getTask(TASK_ID);
		const attempts = store.listAttempts(TASK_ID);
		// The aborted run is cancelled, not double-recorded as a failure.
		expect(attempts).toHaveLength(1);
		expect(store.getAttempt(task?.currentAttemptId ?? "")?.status).toBe("cancelled");
		expect(task?.status).toBe("cancelled");
		expect(store.getWorkflow(WORKFLOW_ID)).toMatchObject({
			status: "cancelled",
			result: { status: "cancelled", reason: "User cancelled" },
		});
		expect(adapter.finalReport).toMatchObject({
			status: "cancelled",
			failureReason: "User cancelled",
		});

		adapter.dispose();
	});

	it("persists cancel_requested before the terminal cancelled event", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });
		session.abortEmits = abortedSettlement();

		await adapter.cancel("User cancelled");

		const eventTypes = new SessionWorkflowEventLog(session.sessionManager)
			.read()
			.flatMap((batch) => batch.batch.events.map((event) => event.eventType));
		expect(eventTypes.indexOf("workflow.cancel_requested")).toBeGreaterThanOrEqual(0);
		expect(eventTypes.indexOf("workflow.cancel_requested")).toBeLessThan(eventTypes.indexOf("workflow.cancelled"));

		adapter.dispose();
	});

	it("treats concurrent cancellation as a single flow", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });
		session.abortEmits = abortedSettlement();

		await Promise.all([adapter.cancel("first"), adapter.cancel("second")]);

		expect(session.abortCalls).toBe(1);
		expect(replay(session).getWorkflow(WORKFLOW_ID)).toMatchObject({
			status: "cancelled",
			result: {
				reason: "first",
			},
		});

		adapter.dispose();
	});

	it("no-ops cancellation after the workflow already completed", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });
		emitRun(session, fauxAssistantMessage("Done"), false);
		expect(adapter.controller.getWorkflow(WORKFLOW_ID)?.status).toBe("completed");

		await adapter.cancel("too late");

		expect(session.abortCalls).toBe(0);
		expect(replay(session).getWorkflow(WORKFLOW_ID)?.status).toBe("completed");

		adapter.dispose();
	});

	it("upgrades an in-flight Direct run to Planning after stopping its writer", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });
		session.abortEmits = abortedSettlement();

		await adapter.upgradeToPlan(highRiskUpgradeDecision());

		expect(session.abortCalls).toBe(1);
		expect(session.waitForIdleCalls).toBe(1);
		const store = replay(session);
		const workflow = store.getWorkflow(WORKFLOW_ID);
		const task = store.getTask(TASK_ID);
		const attempt = task?.currentAttemptId ? store.getAttempt(task.currentAttemptId) : undefined;
		expect(workflow).toMatchObject({
			status: "planning",
			modeDecision: {
				mode: "plan",
				source: "forced_policy",
			},
			directPlanUpgradeRequest: {
				reason: "The change crosses security and storage boundaries",
				riskLevel: "high",
				triggers: ["complexity", "risk", "confidence"],
			},
		});
		expect(attempt?.status).toBe("interrupted");
		expect(task?.status).toBe("ready");
		expect(workflow?.currentPlanId).toBeDefined();
		expect(store.getPlan(workflow?.currentPlanId ?? "")).toMatchObject({
			status: "draft",
			version: 1,
		});
		expect(adapter.statusLine).toBe("plan | planning | root: task-1 (ready) | attempt: 1 | Budget: within limits");

		adapter.dispose();
	});

	it("persists the upgrade request before interruption and the Planning transition", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });
		session.abortEmits = abortedSettlement();

		await adapter.upgradeToPlan(highRiskUpgradeDecision());

		const eventTypes = new SessionWorkflowEventLog(session.sessionManager)
			.read()
			.flatMap((batch) => batch.batch.events.map((event) => event.eventType));
		const requestIndex = eventTypes.indexOf("workflow.direct_plan_upgrade_requested");
		expect(requestIndex).toBeGreaterThanOrEqual(0);
		expect(requestIndex).toBeLessThan(eventTypes.indexOf("attempt.interrupted"));
		expect(eventTypes.indexOf("attempt.interrupted")).toBeLessThan(eventTypes.indexOf("plan.created"));
		expect(eventTypes.indexOf("plan.created")).toBeLessThan(eventTypes.lastIndexOf("workflow.status_changed"));

		adapter.dispose();
	});

	it("treats concurrent Plan upgrades as a single stop-and-transition flow", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });
		session.abortEmits = abortedSettlement();
		const decision = highRiskUpgradeDecision();

		await Promise.all([adapter.upgradeToPlan(decision), adapter.upgradeToPlan(decision)]);

		expect(session.abortCalls).toBe(1);
		expect(replay(session).listPlans(WORKFLOW_ID)).toHaveLength(1);

		adapter.dispose();
	});

	it("cancels a workflow that has not started an attempt yet", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);

		await adapter.cancel("User cancelled early");

		const store = replay(session);
		expect(store.listAttempts(TASK_ID)).toHaveLength(0);
		expect(store.getTask(TASK_ID)?.status).toBe("cancelled");
		expect(store.getWorkflow(WORKFLOW_ID)?.status).toBe("cancelled");

		adapter.dispose();
	});

	it("delegates abort and idle settlement to AgentSession", async () => {
		const session = new FakeAgentSession();
		const adapter = start(session);

		await adapter.abort();

		expect(session.abortCalls).toBe(1);
		expect(session.waitForIdleCalls).toBe(1);
		adapter.dispose();
	});
});
