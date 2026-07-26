import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	SessionWorkflowEventLog,
	startDirectAgentSessionWorkflow,
	type WorkflowAgentSession,
	WorkflowStore,
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

function start(session: FakeAgentSession) {
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
		expect(adapter.statusLine).toBe("direct | executing | task: running | attempt: 1");

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
			statusLine: "direct | completed | 1 task | 0 files | tests: not configured",
			task: {
				status: "succeeded",
			},
			attempts: [{ number: 1, status: "succeeded" }],
		});
		expect(adapter.statusLines?.[0]).toBe("direct | completed | 1 task | 0 files | tests: not configured");

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
