import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
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

class FakeAgentSession implements WorkflowAgentSession {
	readonly sessionManager = SessionManager.inMemory();
	readonly #listeners = new Set<AgentSessionEventListener>();
	abortCalls = 0;
	waitForIdleCalls = 0;

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async abort(): Promise<void> {
		this.abortCalls++;
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

describe("AgentSessionAdapter", () => {
	it("maps a successful AgentSession run to a succeeded Attempt awaiting verification", () => {
		const session = new FakeAgentSession();
		const adapter = start(session);

		expect(adapter.controller.getRootTask(WORKFLOW_ID)?.status).toBe("ready");
		session.emit({ type: "agent_start" });
		const runningTask = adapter.controller.getRootTask(WORKFLOW_ID);
		expect(runningTask?.status).toBe("running");

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
		expect(task?.status).toBe("verifying");
		expect(store.getWorkflow(WORKFLOW_ID)?.status).toBe("executing");
		expect(task?.verificationRequirements[0]).toBeDefined();

		adapter.dispose();
	});

	it("creates a new Attempt after agent_end reports willRetry", () => {
		const session = new FakeAgentSession();
		const adapter = start(session);

		session.emit({ type: "agent_start" });
		emitRun(
			session,
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
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
		emitRun(session, fauxAssistantMessage("Recovered"), false);

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
		expect(store.getWorkflow(WORKFLOW_ID)?.status).toBe("executing");

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
