import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent, AgentSessionEventListener } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import type { DelegationBindingHandle } from "../subagents/subagent-tools.ts";
import type { AgentRunResult } from "../subagents/types.ts";
import {
	selectRecentWorkflowSnapshots,
	type WorkflowContextCheckpoint,
	type WorkflowContextProvider,
} from "./context-window-projection.ts";
import type { StartDirectWorkflowCommand } from "./controller.ts";
import { WorkflowController } from "./controller.ts";
import type { UpgradeDirectToPlanDecision } from "./direct-plan-upgrade.ts";
import { SessionWorkflowEventLog, SessionWorkflowSnapshotStore } from "./event-log.ts";
import {
	buildBasicVerificationReport,
	buildWorkflowFinalReport,
	formatWorkflowStatusLine,
	type WorkflowFinalReport,
} from "./report.ts";
import { evaluateBudget, formatBudgetEvaluation, type PermissionSet, sumResourceUsage } from "./runtime-policy.ts";
import { DEFAULT_WORKFLOW_RUNTIME_REGISTRY, type WorkflowRuntimeRegistry } from "./runtime-registry.ts";
import { WorkflowStore } from "./stores.ts";
import { isWorkflowTerminalStatus } from "./transitions.ts";
import type {
	AttemptId,
	ResourceUsage,
	TaskId,
	ToolOperationReceiptKind,
	VerificationId,
	WorkflowId,
} from "./types.ts";
import { buildWorkflowView, type WorkflowView } from "./view.ts";
import { DEFAULT_WRITER_LEASE_REGISTRY, type WriterLeaseRegistry } from "./writer-lease.ts";

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

function stableJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableJsonValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stableJsonValue(child)]),
	);
}

function receiptSummary(value: string, maxBytes = 256): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
	let selected = "";
	for (const character of normalized) {
		if (Buffer.byteLength(`${selected}${character}...`, "utf8") > maxBytes) break;
		selected += character;
	}
	return `${selected}...`;
}

function receiptInputSummary(args: unknown): string {
	try {
		return receiptSummary(JSON.stringify(stableJsonValue(args)) ?? String(args));
	} catch {
		return receiptSummary(String(args));
	}
}

function receiptResultSummary(result: unknown, isError: boolean): string {
	if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)) {
		const text = result.content
			.flatMap((part) =>
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
					? [part.text]
					: [],
			)
			.join("\n");
		if (text.trim()) return receiptSummary(text);
	}
	return isError
		? "Tool execution failed; exact result remains in History."
		: "Tool execution completed successfully.";
}

export interface WorkflowAgentSession {
	readonly sessionManager: SessionManager;
	getToolDefinition?(name: string): Pick<ToolDefinition, "workflowReceipt"> | undefined;
	subscribe(listener: AgentSessionEventListener): () => void;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
}

export interface AgentSessionAdapterOptions {
	readonly createId?: (kind: "command" | "attempt" | "verification" | "plan") => string;
	readonly now?: () => number;
	readonly writerLeaseRegistry?: WriterLeaseRegistry;
	readonly runtimeRegistry?: WorkflowRuntimeRegistry;
	readonly writerLeaseTtlMs?: number;
	readonly deferCompletion?: boolean;
}

export interface AgentSessionDelegationRequest {
	readonly parentPermission: PermissionSet;
	readonly requiresWriter: boolean;
	readonly runInBackground: boolean;
}

interface PendingAgentEnd {
	readonly message?: AssistantMessage;
}

interface PendingMutation {
	readonly path: string;
	readonly operation: "edit" | "write";
}

interface PendingOperationReceipt {
	readonly kind: ToolOperationReceiptKind;
	readonly inputSummary: string;
}

interface DeferredCompletion {
	readonly verificationId: VerificationId;
	readonly summary: string;
	readonly usage: ResourceUsage;
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

export class AgentSessionAdapter implements WorkflowContextProvider {
	readonly #session: WorkflowAgentSession;
	readonly #controller: WorkflowController;
	readonly #workflowId: WorkflowId;
	readonly #taskId: TaskId;
	readonly #snapshotStore: SessionWorkflowSnapshotStore;
	readonly #createId: (kind: "command" | "attempt" | "verification" | "plan") => string;
	readonly #now: () => number;
	readonly #writerLeaseRegistry: WriterLeaseRegistry;
	readonly #runtimeRegistry: WorkflowRuntimeRegistry;
	readonly #writerLeaseTtlMs: number;
	readonly #deferCompletion: boolean;
	#unsubscribe?: () => void;
	#unregisterRuntime?: () => void;
	#writerLeaseId?: string;
	#activeAttemptId?: AttemptId;
	#attemptStartedAt = 0;
	#attemptUsage: ResourceUsage = zeroUsage();
	#workflowUsage: ResourceUsage = zeroUsage();
	#pendingAgentEnd?: PendingAgentEnd;
	/** True once cancellation begins, so run settlement defers to the cancellation flow. */
	#cancelling = false;
	/** Memoized cancellation run so concurrent/repeated cancel calls share one flow. */
	#cancelPromise?: Promise<void>;
	/** True while a Direct run is stopping before the Workflow enters Planning. */
	#upgradingToPlan = false;
	/** Memoized upgrade run so concurrent/repeated requests share one flow. */
	#planUpgradePromise?: Promise<void>;
	/** In-flight mutation tool calls, keyed by toolCallId, awaiting their result. */
	readonly #pendingMutations = new Map<string, PendingMutation>();
	/** Explicitly marked one-shot or verification calls awaiting a host-observed result. */
	readonly #pendingOperationReceipts = new Map<string, PendingOperationReceipt>();
	/** Paths reported by successful edit/write tools across the whole workflow, in order. */
	readonly #changedFiles: string[] = [];
	#deferredCompletion?: DeferredCompletion;

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
		this.#snapshotStore = new SessionWorkflowSnapshotStore(session.sessionManager);
		this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
		this.#now = options.now ?? Date.now;
		this.#writerLeaseRegistry = options.writerLeaseRegistry ?? DEFAULT_WRITER_LEASE_REGISTRY;
		this.#runtimeRegistry = options.runtimeRegistry ?? DEFAULT_WORKFLOW_RUNTIME_REGISTRY;
		this.#writerLeaseTtlMs = options.writerLeaseTtlMs ?? 3_600_000;
		this.#deferCompletion = options.deferCompletion ?? false;
	}

	get controller(): WorkflowController {
		return this.#controller;
	}

	get workflowId(): WorkflowId {
		return this.#workflowId;
	}

	get taskId(): TaskId {
		return this.#taskId;
	}

	get changedFiles(): readonly string[] {
		return [...this.#changedFiles];
	}

	get hasDeferredCompletion(): boolean {
		return this.#deferredCompletion !== undefined;
	}

	checkpointForContextWindow(): WorkflowContextCheckpoint {
		const snapshot = this.#controller.createSnapshot(this.#workflowId);
		const snapshotEntryId = this.#snapshotStore.append(snapshot);
		return {
			workflowId: this.#workflowId,
			snapshotEntryId,
			snapshot,
			recentWorkflowSnapshots: selectRecentWorkflowSnapshots(this.#controller, this.#workflowId),
		};
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
		const attempts = this.#controller.listAttempts(rootTask.id);
		const status = formatWorkflowStatusLine({
			workflow,
			rootTask,
			attempts,
		});
		const budget = formatBudgetEvaluation(
			evaluateBudget(workflow.budget, sumResourceUsage(attempts.map(({ usage }) => usage)), {
				activeAgents: rootTask.status === "running" || rootTask.status === "verifying" ? 1 : 0,
			}),
		);
		return `${status} | ${budget}`;
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
		return [
			statusLine,
			`Workflow ID: ${workflow.id}`,
			`Task: ${rootTask.status} | ${rootTask.title}`,
			`Writer Lease: ${this.#writerLeaseId ? `held | ${this.#writerLeaseId}` : "not held"}`,
		];
	}

	get view(): WorkflowView | undefined {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		const rootTask = this.#controller.getRootTask(this.#workflowId);
		const statusLine = this.statusLine;
		const reportLines = this.statusLines;
		if (!workflow || !rootTask || !statusLine || !reportLines) {
			return undefined;
		}
		const attempts = this.#controller.listAttempts(rootTask.id);
		return buildWorkflowView({
			workflow,
			rootTask,
			tasks: [rootTask],
			attempts,
			verifications: this.#controller.listVerifications(workflow.id),
			agents: [],
			jobs: [],
			statusLine,
			reportLines,
			budgetStatus: formatBudgetEvaluation(
				evaluateBudget(workflow.budget, sumResourceUsage(attempts.map(({ usage }) => usage)), {
					activeAgents: rootTask.status === "running" || rootTask.status === "verifying" ? 1 : 0,
				}),
			),
		});
	}

	start(): this {
		if (this.#unsubscribe) {
			return this;
		}
		this.#unsubscribe = this.#session.subscribe(this.#handleEvent);
		try {
			const workflow = this.#controller.getWorkflow(this.#workflowId);
			const task = this.#controller.getRootTask(this.#workflowId);
			if (workflow && task?.accessMode === "writer") {
				this.#acquireWriterLease();
			}
			this.#unregisterRuntime = this.#runtimeRegistry.register({
				id: `agent-session:${this.#workflowId}`,
				kind: "agent",
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				stop: async () => {
					await this.#session.abort();
					await this.#session.waitForIdle();
				},
			});
			this.#controller.markTaskReady({
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
			});
		} catch (error) {
			this.#releaseWriterLease();
			this.dispose();
			throw error;
		}
		return this;
	}

	/**
	 * Bind a model-initiated delegation to the currently running Direct Task and Attempt.
	 *
	 * Writer delegations are foreground-only. The parent Writer Lease is released before
	 * dispatch and reacquired after the child settles, so a single writer remains authoritative.
	 */
	bindDelegation(request: AgentSessionDelegationRequest): DelegationBindingHandle {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		const task = this.#controller.getRootTask(this.#workflowId);
		const attemptId = this.#activeAttemptId;
		if (!workflow || workflow.status !== "executing" || !task || task.status !== "running" || !attemptId) {
			throw new Error("Subagent delegation requires a running Direct Workflow Task and Attempt");
		}
		if (request.requiresWriter && request.runInBackground) {
			throw new Error("Writer Subagents must run in the foreground while sharing the parent workspace");
		}
		const transferredWriterLease = request.requiresWriter && this.#writerLeaseId !== undefined;
		if (transferredWriterLease) {
			this.#releaseWriterLease();
		}
		const taskPermission: PermissionSet =
			task.accessMode === "writer"
				? request.parentPermission
				: {
						...request.parentPermission,
						write: false,
						executeCommands: false,
						network: false,
					};
		let settled = false;
		return {
			input: {
				workflowId: workflow.id,
				taskId: task.id,
				attemptId,
				cwd: workflow.request.cwd,
				parentPermission: request.parentPermission,
				workflowPermission: request.parentPermission,
				taskPermission,
				parentBudget: workflow.budget,
				workflowBudget: workflow.budget,
				taskBudget: task.budget,
			},
			settle: (result) => {
				if (settled) {
					return;
				}
				settled = true;
				if (result && this.#activeAttemptId === attemptId) {
					this.#attemptUsage = addResourceUsage(this.#attemptUsage, result.usage);
					this.#recordSubagentModifications(result, attemptId);
				}
				if (transferredWriterLease) {
					const currentWorkflow = this.#controller.getWorkflow(this.#workflowId);
					const currentTask = this.#controller.getRootTask(this.#workflowId);
					if (currentWorkflow?.status === "executing" && currentTask?.status === "running") {
						this.#acquireWriterLease();
					}
				}
			},
		};
	}

	async abort(): Promise<void> {
		await this.#session.abort();
		await this.#session.waitForIdle();
	}

	completeDeferredVerification(input?: {
		readonly evidenceRefs?: readonly string[];
		readonly risks?: readonly string[];
		readonly unfinishedItems?: readonly string[];
	}): void {
		const pending = this.#deferredCompletion;
		if (!pending) {
			throw new Error(`Workflow ${this.#workflowId} has no deferred completion`);
		}
		this.#deferredCompletion = undefined;
		this.#completeVerification(
			pending.verificationId,
			pending.summary,
			pending.usage,
			input?.evidenceRefs,
			input?.risks,
			input?.unfinishedItems,
		);
		this.#unregisterRuntime?.();
		this.#unregisterRuntime = undefined;
		this.#releaseWriterLease();
	}

	prepareProtocolRepair(summary: string, evidenceRefs: readonly string[] = []): void {
		const pending = this.#deferredCompletion;
		if (!pending) {
			throw new Error(`Workflow ${this.#workflowId} has no deferred completion to repair`);
		}
		this.#controller.rejectTaskVerification({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			verificationId: pending.verificationId,
			summary,
			evidenceRefs,
		});
		this.#deferredCompletion = undefined;
	}

	failProtocol(reason: string): void {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (!workflow || isWorkflowTerminalStatus(workflow.status)) {
			return;
		}
		const task = this.#controller.getTask(this.#taskId);
		const usage = this.#deferredCompletion?.usage ?? this.#workflowUsage;
		this.#deferredCompletion = undefined;
		if (task?.status === "ready") {
			const attemptId = this.#createId("attempt");
			this.#controller.prepareMainAgentAttempt({
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				attemptId,
				agentId: "execution-protocol",
				writerLeaseId: this.#writerLeaseId,
			});
			this.#controller.handleRuntimeEvent({
				type: "attempt_started",
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				attemptId,
			});
			this.#controller.handleRuntimeEvent({
				type: "attempt_failed",
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				attemptId,
				usage,
				workflowUsage: usage,
				willRetry: false,
				failure: {
					code: "execution_protocol.failed",
					message: reason,
				},
			});
		} else if (task?.status === "running" && this.#activeAttemptId) {
			this.#controller.handleRuntimeEvent({
				type: "attempt_failed",
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				attemptId: this.#activeAttemptId,
				usage,
				workflowUsage: usage,
				willRetry: false,
				failure: {
					code: "execution_protocol.failed",
					message: reason,
				},
			});
			this.#activeAttemptId = undefined;
		} else {
			this.#controller.fail({
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				reason,
				usage,
				durationMs: Math.max(0, this.#now() - Date.parse(workflow.createdAt)),
				runtimeResourcesStopped: true,
			});
		}
		this.#unregisterRuntime?.();
		this.#unregisterRuntime = undefined;
		this.#releaseWriterLease();
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
		if (this.#planUpgradePromise) {
			await this.#planUpgradePromise;
		}
		this.#cancelPromise ??= this.#runCancellation(reason);
		await this.#cancelPromise;
	}

	requestCancellation(reason: string): void {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (!workflow || isWorkflowTerminalStatus(workflow.status)) {
			return;
		}
		this.#cancelling = true;
		this.#controller.requestCancellation({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			reason,
		});
	}

	async #runCancellation(reason: string): Promise<void> {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (!workflow || isWorkflowTerminalStatus(workflow.status)) {
			return;
		}
		// Phase 1: persist the cancel request. Idempotent if already cancelling.
		this.requestCancellation(reason);
		// Phase 2: stop the AgentSession and wait until it is idle.
		const cancellation = await this.#runtimeRegistry.cancelWorkflow(this.#workflowId, reason);
		if (cancellation.failures.length > 0) {
			throw new Error(`Failed to stop Workflow resources: ${cancellation.failures.map(({ id }) => id).join(", ")}`);
		}
		this.#unregisterRuntime = undefined;
		this.#releaseWriterLease();
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
		this.#deferredCompletion = undefined;
	}

	/**
	 * Stop the current Direct run and atomically move its Workflow into Planning.
	 *
	 * The upgrade request is persisted before aborting the AgentSession. Abort-driven
	 * settlement is suppressed, then the active Attempt is recorded as interrupted,
	 * a draft Plan is created, and the Workflow enters Planning in one event batch.
	 */
	async upgradeToPlan(decision: UpgradeDirectToPlanDecision): Promise<void> {
		if (this.#cancelPromise) {
			await this.#cancelPromise;
			return;
		}
		this.#planUpgradePromise ??= this.#runPlanUpgrade(decision);
		await this.#planUpgradePromise;
	}

	async #runPlanUpgrade(decision: UpgradeDirectToPlanDecision): Promise<void> {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (!workflow || isWorkflowTerminalStatus(workflow.status) || workflow.status === "planning") {
			return;
		}
		this.#upgradingToPlan = true;
		try {
			this.#controller.requestDirectPlanUpgrade({
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				decision,
			});
			await this.#session.abort();
			await this.#session.waitForIdle();
			this.#unregisterRuntime?.();
			this.#unregisterRuntime = undefined;
			this.#releaseWriterLease();
			const attemptUsage = this.#activeAttemptId ? this.#completedUsage() : zeroUsage();
			this.#controller.finishDirectPlanUpgrade({
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				planId: this.#createId("plan"),
				attemptUsage,
				writeAdmissionClosed: true,
				activeWriterStopped: true,
			});
			this.#workflowUsage = addResourceUsage(this.#workflowUsage, attemptUsage);
			this.#activeAttemptId = undefined;
			this.#pendingAgentEnd = undefined;
		} catch (error) {
			this.#upgradingToPlan = false;
			throw error;
		}
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#unregisterRuntime?.();
		this.#unregisterRuntime = undefined;
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (workflow && isWorkflowTerminalStatus(workflow.status)) {
			this.#releaseWriterLease();
		}
	}

	readonly #handleEvent = (event: AgentSessionEvent): void => {
		if (this.#writerLeaseId) {
			this.#writerLeaseRegistry.renew(this.#writerLeaseId, this.#writerLeaseTtlMs);
		}
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
		if (this.#cancelling || this.#upgradingToPlan) {
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
			writerLeaseId: this.#writerLeaseId,
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
		if (!this.#activeAttemptId) {
			return;
		}
		if (MUTATION_TOOL_NAMES.has(event.toolName)) {
			const path = mutatedPath(event.args);
			if (path) {
				this.#pendingMutations.set(event.toolCallId, {
					path,
					operation: event.toolName === "write" ? "write" : "edit",
				});
			}
		}
		const receipt = this.#session.getToolDefinition?.(event.toolName)?.workflowReceipt;
		if (receipt) {
			this.#pendingOperationReceipts.set(event.toolCallId, {
				kind: receipt.kind,
				inputSummary: receiptInputSummary(event.args),
			});
		}
	}

	#handleToolEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		const mutation = this.#pendingMutations.get(event.toolCallId);
		if (mutation !== undefined) {
			this.#pendingMutations.delete(event.toolCallId);
			if (!event.isError) {
				if (!this.#activeAttemptId) {
					throw new Error(`Workflow ${this.#workflowId} recorded a modification without an active Attempt`);
				}
				this.#controller.recordTaskModification({
					commandId: this.#createId("command"),
					workflowId: this.#workflowId,
					taskId: this.#taskId,
					modification: {
						path: mutation.path,
						operation: mutation.operation,
						attemptId: this.#activeAttemptId,
						agentId: "main-agent",
						toolCallId: event.toolCallId,
					},
				});
				if (!this.#changedFiles.includes(mutation.path)) {
					this.#changedFiles.push(mutation.path);
				}
			}
		}

		const pendingReceipt = this.#pendingOperationReceipts.get(event.toolCallId);
		if (!pendingReceipt) return;
		this.#pendingOperationReceipts.delete(event.toolCallId);
		if (!this.#activeAttemptId) {
			throw new Error(`Workflow ${this.#workflowId} recorded a tool receipt without an active Attempt`);
		}
		this.#controller.recordTaskOperationReceipt({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			receipt: {
				attemptId: this.#activeAttemptId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				kind: pendingReceipt.kind,
				status: event.isError ? "failed" : "succeeded",
				inputSummary: pendingReceipt.inputSummary,
				resultSummary: receiptResultSummary(event.result, event.isError),
			},
		});
	}

	#handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// During cancellation the abort-driven run settlement is handled by the
		// cancellation flow, not recorded as a normal success/failure.
		if (this.#cancelling || this.#upgradingToPlan) {
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
		if (this.#cancelling || this.#upgradingToPlan) {
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
			if (this.#deferCompletion) {
				this.#deferredCompletion = {
					verificationId,
					summary,
					usage: workflowUsage,
				};
				return;
			}
			this.#completeVerification(verificationId, summary, workflowUsage);
			this.#unregisterRuntime?.();
			this.#unregisterRuntime = undefined;
			this.#releaseWriterLease();
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
	#completeVerification(
		verificationId: VerificationId,
		summary: string,
		usage: ResourceUsage,
		evidenceRefs: readonly string[] = [],
		risks: readonly string[] = [],
		unfinishedItems: readonly string[] = [],
	): void {
		const report = buildBasicVerificationReport({ changedFiles: this.#changedFiles });
		this.#controller.complete({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			verificationId,
			summary,
			changedFiles: report.changedFiles,
			evidenceRefs: [...report.evidenceRefs, ...evidenceRefs],
			risks,
			unfinishedItems,
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
		if (!willRetry) {
			this.#unregisterRuntime?.();
			this.#unregisterRuntime = undefined;
			this.#releaseWriterLease();
		}
	}

	#completedUsage(): ResourceUsage {
		return {
			...this.#attemptUsage,
			durationMs: Math.max(0, this.#now() - this.#attemptStartedAt),
		};
	}

	#recordSubagentModifications(result: AgentRunResult, attemptId: AttemptId): void {
		for (const modification of result.modifications) {
			this.#controller.recordTaskModification({
				commandId: this.#createId("command"),
				workflowId: this.#workflowId,
				taskId: this.#taskId,
				modification: {
					path: modification.path,
					operation: modification.operation,
					attemptId,
					agentId: result.agentId,
					toolCallId: modification.toolCallId,
				},
			});
			if (!this.#changedFiles.includes(modification.path)) {
				this.#changedFiles.push(modification.path);
			}
		}
	}

	#acquireWriterLease(): void {
		if (this.#writerLeaseId) {
			this.#writerLeaseRegistry.renew(this.#writerLeaseId, this.#writerLeaseTtlMs);
			return;
		}
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (!workflow) {
			throw new Error(`Workflow ${this.#workflowId} does not exist`);
		}
		const lease = this.#writerLeaseRegistry.acquire({
			workspace: workflow.request.cwd,
			workflowId: this.#workflowId,
			taskId: this.#taskId,
			attemptId: this.#activeAttemptId,
			ttlMs: this.#writerLeaseTtlMs,
		});
		this.#writerLeaseId = lease.id;
	}

	#releaseWriterLease(): void {
		if (this.#writerLeaseId) {
			this.#writerLeaseRegistry.release(this.#writerLeaseId);
			this.#writerLeaseId = undefined;
		}
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
