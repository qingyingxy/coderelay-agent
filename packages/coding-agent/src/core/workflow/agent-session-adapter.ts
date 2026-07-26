import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent, AgentSessionEventListener } from "../agent-session.ts";
import type { SessionManager } from "../session-manager.ts";
import type { StartDirectWorkflowCommand } from "./controller.ts";
import { WorkflowController } from "./controller.ts";
import { SessionWorkflowEventLog } from "./event-log.ts";
import {
	buildBasicVerificationReport,
	buildWorkflowFinalReport,
	formatWorkflowStatusLine,
	type WorkflowFinalReport,
} from "./report.ts";
import { WorkflowStore } from "./stores.ts";
import { isWorkflowTerminalStatus } from "./transitions.ts";
import type { AttemptId, ResourceUsage, TaskId, VerificationId, WorkflowId } from "./types.ts";

/** Built-in tools whose successful results contribute to the changed-file summary. */
const MUTATION_TOOL_NAMES = new Set(["edit", "write"]);

function mutatedPath(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	const candidate = args as { path?: unknown; file_path?: unknown };
	if (typeof candidate.path === "string" && candidate.path.length > 0) {
		return candidate.path;
	}
	if (typeof candidate.file_path === "string" && candidate.file_path.length > 0) {
		return candidate.file_path;
	}
	return undefined;
}

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

function addResourceUsage(target: ResourceUsage, usage: ResourceUsage): ResourceUsage {
	return {
		inputTokens: target.inputTokens + usage.inputTokens,
		outputTokens: target.outputTokens + usage.outputTokens,
		cacheReadTokens: target.cacheReadTokens + usage.cacheReadTokens,
		cacheWriteTokens: target.cacheWriteTokens + usage.cacheWriteTokens,
		cost: target.cost + usage.cost,
		turns: target.turns + usage.turns,
		durationMs: target.durationMs + usage.durationMs,
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
	#workflowUsage: ResourceUsage = zeroUsage();
	#pendingAgentEnd?: PendingAgentEnd;
	/** True once cancellation begins, so run settlement defers to the cancellation flow. */
	#cancelling = false;
	/** Memoized cancellation run so concurrent/repeated cancel calls share one flow. */
	#cancelPromise?: Promise<void>;
	/** In-flight mutation tool calls, keyed by toolCallId, awaiting their result. */
	readonly #pendingMutations = new Map<string, string>();
	/** Paths reported by successful edit/write tools across the whole workflow, in order. */
	readonly #changedFiles: string[] = [];

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

	get finalReport(): WorkflowFinalReport | undefined {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		const rootTask = this.#controller.getRootTask(this.#workflowId);
		if (!workflow || !rootTask || !isWorkflowTerminalStatus(workflow.status) || !workflow.result) {
			return undefined;
		}
		const verifications = workflow.result.verificationIds.flatMap((verificationId) => {
			const verification = this.#controller.getVerification(verificationId);
			return verification ? [verification] : [];
		});
		return buildWorkflowFinalReport({
			workflow,
			rootTask,
			attempts: this.#controller.listAttempts(rootTask.id),
			verifications,
		});
	}

	/** Current authoritative status line, derived from the Workflow Store. */
	get statusLine(): string | undefined {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		const rootTask = this.#controller.getRootTask(this.#workflowId);
		if (!workflow || !rootTask) {
			return undefined;
		}
		return formatWorkflowStatusLine({
			workflow,
			rootTask,
			attempts: this.#controller.listAttempts(rootTask.id),
		});
	}

	/** Current or terminal summary rendered by `/workflow`. */
	get statusLines(): readonly string[] | undefined {
		const finalReport = this.finalReport;
		if (finalReport) {
			return finalReport.lines;
		}
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		const rootTask = this.#controller.getRootTask(this.#workflowId);
		const statusLine = this.statusLine;
		if (!workflow || !rootTask || !statusLine) {
			return undefined;
		}
		return [statusLine, `Workflow ID: ${workflow.id}`, `Task: ${rootTask.status} | ${rootTask.title}`];
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

	/**
	 * Cancel the Direct workflow in two phases (design §5.3).
	 *
	 * Phase 1 persists the cancel request (`executing → cancelling`). Phase 2 stops
	 * the AgentSession and waits for it to return to idle. Only then does phase 3
	 * finalize the terminal `cancelled` state (attempt → task → workflow). The run
	 * settlement events that fire during `abort()` are suppressed while `#cancelling`
	 * is set, so an aborted run is not double-recorded as a failure.
	 *
	 * Repeated or concurrent calls share the same in-flight cancellation.
	 */
	async cancel(reason: string): Promise<void> {
		this.#cancelPromise ??= this.#runCancellation(reason);
		await this.#cancelPromise;
	}

	async #runCancellation(reason: string): Promise<void> {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (!workflow || isWorkflowTerminalStatus(workflow.status)) {
			return;
		}
		this.#cancelling = true;
		// Phase 1: persist the cancel request. Idempotent if already cancelling.
		this.#controller.requestCancellation({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			reason,
		});
		// Phase 2: stop the AgentSession and wait until it is idle.
		await this.#session.abort();
		await this.#session.waitForIdle();
		// Phase 3: finalize the terminal cancelled state.
		this.#finishCancellation(reason);
	}

	#finishCancellation(reason: string): void {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (!workflow || workflow.status !== "cancelling") {
			return;
		}
		const attemptUsage = this.#activeAttemptId ? this.#completedUsage() : zeroUsage();
		const workflowUsage = addResourceUsage(this.#workflowUsage, attemptUsage);
		this.#controller.finishCancellation({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			reason,
			usage: workflowUsage,
			attemptUsage,
			durationMs: workflowUsage.durationMs,
			runtimeResourcesStopped: true,
			writerLeaseReleased: true,
		});
		this.#workflowUsage = workflowUsage;
		this.#activeAttemptId = undefined;
		this.#pendingAgentEnd = undefined;
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
			case "tool_execution_start":
				this.#handleToolStart(event);
				return;
			case "tool_execution_end":
				this.#handleToolEnd(event);
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
		if (this.#cancelling) {
			return;
		}
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

	#handleToolStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): void {
		if (!this.#activeAttemptId || !MUTATION_TOOL_NAMES.has(event.toolName)) {
			return;
		}
		const path = mutatedPath(event.args);
		if (path) {
			this.#pendingMutations.set(event.toolCallId, path);
		}
	}

	#handleToolEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		const path = this.#pendingMutations.get(event.toolCallId);
		if (path === undefined) {
			return;
		}
		this.#pendingMutations.delete(event.toolCallId);
		// Only successful edit/write results count; failed mutations are not claimed.
		if (event.isError) {
			return;
		}
		if (!this.#changedFiles.includes(path)) {
			this.#changedFiles.push(path);
		}
	}

	#handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// During cancellation the abort-driven run settlement is handled by the
		// cancellation flow, not recorded as a normal success/failure.
		if (this.#cancelling) {
			this.#pendingAgentEnd = undefined;
			return;
		}
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
		if (this.#cancelling) {
			this.#pendingAgentEnd = undefined;
			return;
		}
		if (!this.#activeAttemptId || !this.#pendingAgentEnd) {
			return;
		}
		const { message } = this.#pendingAgentEnd;
		this.#pendingAgentEnd = undefined;
		if (message?.stopReason === "stop") {
			const attemptId = this.#activeAttemptId;
			const summary = contentText(message.content, "").trim() || "AgentSession completed";
			const attemptUsage = this.#completedUsage();
			const workflowUsage = addResourceUsage(this.#workflowUsage, attemptUsage);
			const verificationId = this.#createId("verification");
			this.#controller.handleRuntimeEvent({
				type: "attempt_succeeded",
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				attemptId,
				verificationId,
				usage: attemptUsage,
				summary,
			});
			this.#workflowUsage = workflowUsage;
			this.#activeAttemptId = undefined;
			this.#completeVerification(verificationId, summary, workflowUsage);
			return;
		}
		this.#recordAttemptFailure(message, false);
	}

	/**
	 * Run M1 basic verification and drive the workflow to `completed`.
	 *
	 * Basic verification only confirms what M1 can honestly assert: the attempt
	 * settled successfully with no active attempt remaining, and the successful
	 * edit/write results form the changed-file set. Review/Test/Build are reported
	 * as not configured and never fabricated. The controller invariants enforce the
	 * remaining structural checks (attempt succeeded, task verifying, verification running).
	 */
	#completeVerification(verificationId: VerificationId, summary: string, usage: ResourceUsage): void {
		const report = buildBasicVerificationReport({ changedFiles: this.#changedFiles });
		this.#controller.complete({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			verificationId,
			summary,
			changedFiles: report.changedFiles,
			evidenceRefs: report.evidenceRefs,
			risks: [],
			unfinishedItems: [],
			usage,
			durationMs: usage.durationMs,
		});
	}

	#recordAttemptFailure(message: AssistantMessage | undefined, willRetry: boolean): void {
		if (!this.#activeAttemptId) {
			throw new Error(`Workflow ${this.#workflowId} has no active attempt to fail`);
		}
		const attemptUsage = this.#completedUsage();
		const workflowUsage = addResourceUsage(this.#workflowUsage, attemptUsage);
		this.#controller.handleRuntimeEvent({
			type: "attempt_failed",
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			attemptId: this.#activeAttemptId,
			usage: attemptUsage,
			workflowUsage,
			willRetry,
			failure: failureFrom(message),
		});
		this.#workflowUsage = workflowUsage;
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
