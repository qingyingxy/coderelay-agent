import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent, AgentSessionEventListener } from "../agent-session.ts";
import type { SessionManager } from "../session-manager.ts";
import type { StartDirectWorkflowCommand } from "./controller.ts";
import { WorkflowController } from "./controller.ts";
import { SessionWorkflowEventLog } from "./event-log.ts";
import { WorkflowStore } from "./stores.ts";
import type { AttemptId, ResourceUsage, TaskId, WorkflowId } from "./types.ts";

export interface WorkflowAgentSession {
	readonly sessionManager: SessionManager;
	subscribe(listener: AgentSessionEventListener): () => void;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
}

export interface AgentSessionAdapterOptions {
	readonly createId?: (kind: "command" | "attempt" | "verification") => string;
	readonly now?: () => number;
}

interface PendingAgentEnd {
	readonly message?: AssistantMessage;
}

function zeroUsage(): ResourceUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		turns: 0,
		durationMs: 0,
	};
}

function addUsage(target: ResourceUsage, usage: Usage): ResourceUsage {
	return {
		...target,
		inputTokens: target.inputTokens + usage.input,
		outputTokens: target.outputTokens + usage.output,
		cacheReadTokens: target.cacheReadTokens + usage.cacheRead,
		cacheWriteTokens: target.cacheWriteTokens + usage.cacheWrite,
		cost: target.cost + usage.cost.total,
	};
}

function lastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function failureFrom(message: AssistantMessage | undefined): { code: string; message: string } {
	if (!message) {
		return {
			code: "agent.missing_final_message",
			message: "AgentSession ended without a final Assistant message",
		};
	}
	switch (message.stopReason) {
		case "error":
			return {
				code: "agent.error",
				message: message.errorMessage?.trim() || "AgentSession returned an error",
			};
		case "length":
			return {
				code: "agent.length",
				message: "AgentSession stopped because the model output limit was reached",
			};
		case "aborted":
			return {
				code: "agent.aborted",
				message: message.errorMessage?.trim() || "AgentSession was aborted without a Workflow cancellation",
			};
		case "toolUse":
			return {
				code: "agent.incomplete_tool_use",
				message: "AgentSession ended with an unresolved tool call",
			};
		case "stop":
			return {
				code: "agent.unexpected_stop",
				message: "AgentSession stopped unexpectedly",
			};
	}
}

export class AgentSessionAdapter {
	readonly #session: WorkflowAgentSession;
	readonly #controller: WorkflowController;
	readonly #workflowId: WorkflowId;
	readonly #taskId: TaskId;
	readonly #createId: (kind: "command" | "attempt" | "verification") => string;
	readonly #now: () => number;
	#unsubscribe?: () => void;
	#activeAttemptId?: AttemptId;
	#attemptStartedAt = 0;
	#attemptUsage: ResourceUsage = zeroUsage();
	#pendingAgentEnd?: PendingAgentEnd;

	constructor(
		session: WorkflowAgentSession,
		controller: WorkflowController,
		workflowId: WorkflowId,
		taskId: TaskId,
		options: AgentSessionAdapterOptions = {},
	) {
		this.#session = session;
		this.#controller = controller;
		this.#workflowId = workflowId;
		this.#taskId = taskId;
		this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
		this.#now = options.now ?? Date.now;
	}

	get controller(): WorkflowController {
		return this.#controller;
	}

	start(): this {
		if (this.#unsubscribe) {
			return this;
		}
		this.#unsubscribe = this.#session.subscribe(this.#handleEvent);
		try {
			this.#controller.markTaskReady({
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
			});
		} catch (error) {
			this.dispose();
			throw error;
		}
		return this;
	}

	async abort(): Promise<void> {
		await this.#session.abort();
		await this.#session.waitForIdle();
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	readonly #handleEvent = (event: AgentSessionEvent): void => {
		switch (event.type) {
			case "agent_start":
				this.#handleAgentStart();
				return;
			case "message_end":
				this.#recordMessageUsage(event.message);
				return;
			case "turn_end":
				this.#attemptUsage = {
					...this.#attemptUsage,
					turns: this.#attemptUsage.turns + 1,
				};
				return;
			case "agent_end":
				this.#handleAgentEnd(event);
				return;
			case "agent_settled":
				this.#handleAgentSettled();
				return;
		}
	};

	#handleAgentStart(): void {
		this.#pendingAgentEnd = undefined;
		const task = this.#controller.getRootTask(this.#workflowId);
		if (!task) {
			throw new Error(`Workflow ${this.#workflowId} has no root task`);
		}
		if (task.status === "running" && this.#activeAttemptId) {
			return;
		}
		if (task.status !== "ready") {
			throw new Error(`Root task ${task.id} cannot start an AgentSession attempt from ${task.status}`);
		}

		const attemptId = this.#createId("attempt");
		this.#controller.prepareMainAgentAttempt({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			attemptId,
			agentId: "main-agent",
		});
		this.#controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			attemptId,
		});
		this.#activeAttemptId = attemptId;
		this.#attemptStartedAt = this.#now();
		this.#attemptUsage = zeroUsage();
	}

	#recordMessageUsage(message: AgentMessage): void {
		if (!this.#activeAttemptId || (message.role !== "assistant" && message.role !== "toolResult")) {
			return;
		}
		if (message.usage) {
			this.#attemptUsage = addUsage(this.#attemptUsage, message.usage);
		}
	}

	#handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		if (!this.#activeAttemptId) {
			throw new Error(`Workflow ${this.#workflowId} received agent_end without an active attempt`);
		}
		const message = lastAssistantMessage(event.messages);
		if (!event.willRetry) {
			this.#pendingAgentEnd = { message };
			return;
		}
		this.#recordAttemptFailure(message, true);
	}

	#handleAgentSettled(): void {
		if (!this.#activeAttemptId || !this.#pendingAgentEnd) {
			return;
		}
		const { message } = this.#pendingAgentEnd;
		this.#pendingAgentEnd = undefined;
		if (message?.stopReason === "stop") {
			const summary = contentText(message.content, "").trim() || "AgentSession completed";
			this.#controller.handleRuntimeEvent({
				type: "attempt_succeeded",
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				attemptId: this.#activeAttemptId,
				verificationId: this.#createId("verification"),
				usage: this.#completedUsage(),
				summary,
			});
			this.#activeAttemptId = undefined;
			return;
		}
		this.#recordAttemptFailure(message, false);
	}

	#recordAttemptFailure(message: AssistantMessage | undefined, willRetry: boolean): void {
		if (!this.#activeAttemptId) {
			throw new Error(`Workflow ${this.#workflowId} has no active attempt to fail`);
		}
		this.#controller.handleRuntimeEvent({
			type: "attempt_failed",
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			attemptId: this.#activeAttemptId,
			usage: this.#completedUsage(),
			willRetry,
			failure: failureFrom(message),
		});
		this.#activeAttemptId = undefined;
		this.#pendingAgentEnd = undefined;
	}

	#completedUsage(): ResourceUsage {
		return {
			...this.#attemptUsage,
			durationMs: Math.max(0, this.#now() - this.#attemptStartedAt),
		};
	}
}

export function startDirectAgentSessionWorkflow(
	session: WorkflowAgentSession,
	command: StartDirectWorkflowCommand,
	options: AgentSessionAdapterOptions = {},
): AgentSessionAdapter {
	const controller = new WorkflowController(new SessionWorkflowEventLog(session.sessionManager), new WorkflowStore());
	const result = controller.startDirect(command);
	if (!result.rootTask) {
		throw new Error(`Workflow ${command.workflowId} did not create a root task`);
	}
	return new AgentSessionAdapter(session, controller, result.workflow.id, result.rootTask.id, options).start();
}
