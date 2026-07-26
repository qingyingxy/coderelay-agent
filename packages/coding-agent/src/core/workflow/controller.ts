import { randomUUID } from "crypto";
import type { SessionWorkflowEventLog } from "./event-log.ts";
import type { WorkflowEventDraft } from "./events.ts";
import { createWorkflowEventBatch } from "./events.ts";
import type { WorkflowStore } from "./stores.ts";
import { isAttemptTerminalStatus, isTaskTerminalStatus, isWorkflowTerminalStatus } from "./transitions.ts";
import type {
	Attempt,
	AttemptId,
	BudgetLimit,
	CommandId,
	CorrelationId,
	FailureRecord,
	IsoDateTime,
	ResourceUsage,
	Task,
	TaskId,
	UserRequest,
	VerificationId,
	VerificationRequirement,
	VerificationResult,
	Workflow,
	WorkflowId,
} from "./types.ts";
import { WORKFLOW_SCHEMA_VERSION } from "./types.ts";

const DEFAULT_COMPLETION_REQUIREMENT: VerificationRequirement = {
	id: "agent-session-complete",
	kind: "manual",
	description: "AgentSession ended successfully without an unhandled runtime error",
	required: true,
};

export interface WorkflowCommandBase {
	readonly commandId: CommandId;
	readonly workflowId: WorkflowId;
	readonly correlationId?: CorrelationId;
}

export interface StartDirectWorkflowCommand extends WorkflowCommandBase {
	readonly rootTaskId: TaskId;
	readonly request: UserRequest;
	readonly title?: string;
	readonly description?: string;
	readonly budget?: BudgetLimit;
	readonly verificationRequirements?: readonly VerificationRequirement[];
}

export interface MarkTaskReadyCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly blockResolved?: boolean;
}

export interface PrepareMainAgentAttemptCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly agentId?: string;
}

interface RuntimeEventBase extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
}

export type DirectRuntimeEvent =
	| (RuntimeEventBase & {
			readonly type: "attempt_started";
	  })
	| (RuntimeEventBase & {
			readonly type: "attempt_succeeded";
			readonly verificationId: VerificationId;
			readonly requirementId?: string;
			readonly usage: ResourceUsage;
			readonly summary: string;
			readonly evidenceRefs?: readonly string[];
	  })
	| (RuntimeEventBase & {
			readonly type: "attempt_failed";
			readonly usage: ResourceUsage;
			/** Aggregate Workflow usage through this Attempt. Defaults to `usage` for single-attempt callers. */
			readonly workflowUsage?: ResourceUsage;
			readonly willRetry: boolean;
			readonly failure: Omit<FailureRecord, "retryable">;
	  });

export interface CompleteWorkflowCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly verificationId: VerificationId;
	readonly summary: string;
	readonly changedFiles: readonly string[];
	readonly evidenceRefs?: readonly string[];
	readonly risks?: readonly string[];
	readonly unfinishedItems?: readonly string[];
	readonly usage: ResourceUsage;
	readonly durationMs: number;
}

export interface FailWorkflowCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly reason: string;
	readonly usage: ResourceUsage;
	readonly durationMs: number;
	readonly runtimeResourcesStopped: boolean;
}

export interface RequestWorkflowCancellationCommand extends WorkflowCommandBase {
	readonly reason: string;
}

export interface FinishWorkflowCancellationCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly reason: string;
	/** Aggregate Workflow usage through cancellation. */
	readonly usage: ResourceUsage;
	/** Usage of the active Attempt only. Defaults to `usage` for single-attempt callers. */
	readonly attemptUsage?: ResourceUsage;
	readonly durationMs: number;
	readonly runtimeResourcesStopped: boolean;
	readonly writerLeaseReleased: boolean;
}

export type WorkflowControllerIdKind = "batch" | "event";

export interface WorkflowControllerOptions {
	readonly createId?: (kind: WorkflowControllerIdKind) => string;
	readonly now?: () => IsoDateTime;
}

export interface WorkflowCommandResult {
	readonly applied: boolean;
	readonly batchId?: string;
	readonly workflow: Workflow;
	readonly rootTask?: Task;
}

export class WorkflowControllerError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WorkflowControllerError";
		this.code = code;
	}
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

function assertValidUsage(usage: ResourceUsage): void {
	const values = [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheWriteTokens,
		usage.cost,
		usage.turns,
		usage.durationMs,
	];
	if (values.some((value) => !Number.isFinite(value) || value < 0)) {
		fail("controller.invalid_usage", "Resource usage must contain non-negative numbers");
	}
}

function assertValidDuration(durationMs: number): void {
	if (!Number.isFinite(durationMs) || durationMs < 0) {
		fail("controller.invalid_duration", "Workflow duration must be non-negative");
	}
}

function fail(code: string, message: string): never {
	throw new WorkflowControllerError(code, message);
}

export class WorkflowController {
	readonly #eventLog: SessionWorkflowEventLog;
	readonly #store: WorkflowStore;
	readonly #createId: (kind: WorkflowControllerIdKind) => string;
	readonly #now: () => IsoDateTime;

	constructor(eventLog: SessionWorkflowEventLog, store: WorkflowStore, options: WorkflowControllerOptions = {}) {
		this.#eventLog = eventLog;
		this.#store = store;
		this.#createId = options.createId ?? (() => randomUUID());
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#store.replay(this.#eventLog.read());
	}

	startDirect(command: StartDirectWorkflowCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		if (this.#store.getWorkflow(command.workflowId)) {
			fail("controller.workflow_exists", `Workflow ${command.workflowId} already exists`);
		}
		if (command.request.requestedMode === "plan") {
			fail("controller.mode_conflict", "A Direct workflow cannot override an explicit Plan mode request");
		}
		const requirements = structuredClone(command.verificationRequirements ?? [DEFAULT_COMPLETION_REQUIREMENT]);
		if (requirements.filter((requirement) => requirement.required).length !== 1) {
			fail("controller.verification_required", "M1 Direct workflow requires exactly one required verification");
		}

		const occurredAt = this.#now();
		const budget = structuredClone(command.budget ?? {});
		const workflow: Workflow = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: 0,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			id: command.workflowId,
			status: "received",
			request: structuredClone(command.request),
			rootTaskId: command.rootTaskId,
			budget,
			usage: zeroUsage(),
		};
		const task: Task = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: 0,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			id: command.rootTaskId,
			workflowId: command.workflowId,
			kind: "agent",
			title: command.title?.trim() || "Direct request",
			description: command.description?.trim() || command.request.text,
			status: "pending",
			dependencyIds: [],
			budget,
			usage: zeroUsage(),
			attemptIds: [],
			verificationRequirements: requirements,
		};
		const workflowCreatedId = this.#eventId();
		const modeDecidedId = this.#eventId();
		const taskCreatedId = this.#eventId();
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: workflowCreatedId,
				entityId: workflow.id,
				entityRevision: 0,
				eventType: "workflow.created",
				occurredAt,
				actor: { kind: "controller" },
				payload: { workflow },
			},
			{
				eventId: modeDecidedId,
				entityId: workflow.id,
				entityRevision: 1,
				eventType: "workflow.mode_decided",
				occurredAt,
				actor: { kind: "controller" },
				causationId: workflowCreatedId,
				payload: {
					decision: {
						mode: "direct",
						source: command.request.requestedMode === "direct" ? "user" : "default",
						reason:
							command.request.requestedMode === "direct"
								? "User selected Direct mode"
								: "M1 defaults ordinary requests to Direct mode",
						riskLevel: "low",
						decidedAt: occurredAt,
					},
				},
			},
			{
				eventId: taskCreatedId,
				entityId: task.id,
				entityRevision: 0,
				eventType: "task.created",
				occurredAt,
				actor: { kind: "controller" },
				causationId: modeDecidedId,
				payload: { task },
			},
			{
				eventId: this.#eventId(),
				entityId: workflow.id,
				entityRevision: 2,
				eventType: "workflow.status_changed",
				occurredAt,
				actor: { kind: "controller" },
				causationId: taskCreatedId,
				payload: {
					fromStatus: "received",
					toStatus: "executing",
					facts: {
						directModeSelected: true,
						rootTaskExists: true,
					},
				},
			},
		];
		return this.#commit(command, events);
	}

	markTaskReady(command: MarkTaskReadyCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const task = this.#requireTask(command.taskId, command.workflowId);
		const dependenciesSucceeded = task.dependencyIds.every(
			(dependencyId) => this.#store.getTask(dependencyId)?.status === "succeeded",
		);
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: this.#eventId(),
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.ready",
				occurredAt: this.#now(),
				actor: { kind: "controller" },
				payload: {
					fromStatus: task.status,
					toStatus: "ready",
					facts: {
						workflowExecuting: workflow.status === "executing",
						dependenciesSucceeded,
						blockResolved: command.blockResolved,
					},
				},
			},
		];
		return this.#commit(command, events);
	}

	prepareMainAgentAttempt(command: PrepareMainAgentAttemptCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		if (workflow.status !== "executing") {
			fail("controller.workflow_not_executing", `Workflow ${workflow.id} is not executing`);
		}
		const task = this.#requireTask(command.taskId, command.workflowId);
		if (task.status !== "ready") {
			fail("controller.task_not_ready", `Task ${task.id} must be ready before creating an attempt`);
		}
		if (this.#store.getAttempt(command.attemptId)) {
			fail("controller.attempt_exists", `Attempt ${command.attemptId} already exists`);
		}

		const occurredAt = this.#now();
		const attempt: Attempt = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: 0,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			id: command.attemptId,
			workflowId: command.workflowId,
			taskId: task.id,
			number: this.#store.listAttempts(task.id).length + 1,
			status: "queued",
			executorKind: "main_agent",
			agentId: command.agentId,
			usage: zeroUsage(),
		};
		const attemptCreatedId = this.#eventId();
		const taskAssignedId = this.#eventId();
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: attemptCreatedId,
				entityId: attempt.id,
				entityRevision: 0,
				eventType: "attempt.created",
				occurredAt,
				actor: { kind: "controller" },
				payload: { attempt },
			},
			{
				eventId: taskAssignedId,
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.assigned",
				occurredAt,
				actor: { kind: "controller" },
				causationId: attemptCreatedId,
				payload: {
					assignment: {
						executorKind: "main_agent",
						agentId: command.agentId,
					},
				},
			},
			{
				eventId: this.#eventId(),
				entityId: task.id,
				entityRevision: task.revision + 2,
				eventType: "task.started",
				occurredAt,
				actor: { kind: "controller" },
				causationId: taskAssignedId,
				payload: {
					fromStatus: task.status,
					toStatus: "running",
					facts: {
						attemptCreated: true,
					},
					attemptId: attempt.id,
				},
			},
		];
		return this.#commit(command, events);
	}

	handleRuntimeEvent(event: DirectRuntimeEvent): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(event);
		if (duplicate) {
			return duplicate;
		}
		switch (event.type) {
			case "attempt_started":
				return this.#recordAttemptStarted(event);
			case "attempt_succeeded":
				return this.#recordAttemptSucceeded(event);
			case "attempt_failed":
				return this.#recordAttemptFailed(event);
		}
	}

	complete(command: CompleteWorkflowCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const task = this.#requireTask(command.taskId, command.workflowId);
		const verification = this.#store.getVerification(command.verificationId);
		const verificationRevision = this.#store.getVerificationRevision(command.verificationId);
		if (!verification || verificationRevision === undefined || verification.status !== "running") {
			fail("controller.verification_not_running", `Verification ${command.verificationId} must be running`);
		}
		if (verification.workflowId !== workflow.id || verification.taskId !== task.id) {
			fail(
				"controller.verification_owner_mismatch",
				`Verification ${verification.id} does not belong to task ${task.id}`,
			);
		}
		const attempt = task.currentAttemptId ? this.#store.getAttempt(task.currentAttemptId) : undefined;
		if (!attempt || attempt.status !== "succeeded") {
			fail("controller.attempt_not_succeeded", `Task ${task.id} has no succeeded current attempt`);
		}
		if (task.status !== "verifying" || workflow.status !== "executing") {
			fail("controller.not_ready_to_complete", "Workflow and root task are not ready for completion");
		}
		assertValidUsage(command.usage);
		assertValidDuration(command.durationMs);

		const occurredAt = this.#now();
		const verificationPassedId = this.#eventId();
		const taskSucceededId = this.#eventId();
		const workflowVerifyingId = this.#eventId();
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: verificationPassedId,
				entityId: verification.id,
				entityRevision: verificationRevision + 1,
				eventType: "verification.passed",
				occurredAt,
				actor: { kind: "controller" },
				payload: {
					result: {
						...verification,
						status: "passed",
						summary: command.summary,
						evidenceRefs: structuredClone(command.evidenceRefs ?? verification.evidenceRefs),
						endedAt: occurredAt,
					},
				},
			},
			{
				eventId: taskSucceededId,
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.succeeded",
				occurredAt,
				actor: { kind: "controller" },
				causationId: verificationPassedId,
				payload: {
					fromStatus: task.status,
					toStatus: "succeeded",
					facts: {
						attemptSucceeded: true,
						taskResultPresent: true,
						requiredVerificationPassed: true,
					},
					result: {
						summary: command.summary,
						changedFiles: structuredClone(command.changedFiles),
						verificationIds: [verification.id],
						completedAt: occurredAt,
					},
				},
			},
			{
				eventId: workflowVerifyingId,
				entityId: workflow.id,
				entityRevision: workflow.revision + 1,
				eventType: "workflow.status_changed",
				occurredAt,
				actor: { kind: "controller" },
				causationId: taskSucceededId,
				payload: {
					fromStatus: workflow.status,
					toStatus: "verifying",
					facts: {
						allRequiredTasksSucceeded: true,
					},
				},
			},
			{
				eventId: this.#eventId(),
				entityId: workflow.id,
				entityRevision: workflow.revision + 2,
				eventType: "workflow.completed",
				occurredAt,
				actor: { kind: "controller" },
				causationId: workflowVerifyingId,
				payload: {
					fromStatus: "verifying",
					toStatus: "completed",
					facts: {
						completionGatePassed: true,
					},
					result: {
						status: "completed",
						summary: command.summary,
						completedTaskIds: [task.id],
						failedTaskIds: [],
						changedFiles: structuredClone(command.changedFiles),
						verificationIds: [verification.id],
						risks: structuredClone(command.risks ?? []),
						unfinishedItems: structuredClone(command.unfinishedItems ?? []),
						usage: structuredClone(command.usage),
						durationMs: command.durationMs,
					},
				},
			},
		];
		return this.#commit(command, events);
	}

	fail(command: FailWorkflowCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const task = this.#requireTask(command.taskId, command.workflowId);
		if (isWorkflowTerminalStatus(workflow.status)) {
			fail("controller.workflow_terminal", `Workflow ${workflow.id} is already terminal`);
		}
		assertValidUsage(command.usage);
		assertValidDuration(command.durationMs);
		const activeAttempt = task.currentAttemptId ? this.#store.getAttempt(task.currentAttemptId) : undefined;
		if (activeAttempt && !isAttemptTerminalStatus(activeAttempt.status)) {
			fail(
				"controller.attempt_active",
				`Attempt ${activeAttempt.id} must end before explicitly failing the workflow`,
			);
		}

		const occurredAt = this.#now();
		const events: WorkflowEventDraft[] = [];
		let causationId: string | undefined;
		if (!isTaskTerminalStatus(task.status)) {
			if (task.status !== "running" && task.status !== "verifying" && task.status !== "blocked") {
				fail("controller.task_not_failable", `Task ${task.id} cannot fail from ${task.status}`);
			}
			causationId = this.#eventId();
			events.push({
				eventId: causationId,
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.failed",
				occurredAt,
				actor: { kind: "controller" },
				payload: {
					fromStatus: task.status,
					toStatus: "failed",
					facts: {
						failureTerminalCondition: true,
						activeAttemptStopped: true,
					},
					reason: command.reason,
				},
			});
		}
		events.push({
			eventId: this.#eventId(),
			entityId: workflow.id,
			entityRevision: workflow.revision + 1,
			eventType: "workflow.failed",
			occurredAt,
			actor: { kind: "controller" },
			causationId,
			payload: {
				fromStatus: workflow.status,
				toStatus: "failed",
				facts: {
					failureTerminalCondition: true,
					runtimeResourcesStopped: command.runtimeResourcesStopped,
				},
				result: {
					status: "failed",
					summary: command.reason,
					completedTaskIds: task.status === "succeeded" ? [task.id] : [],
					failedTaskIds: task.status === "succeeded" ? [] : [task.id],
					changedFiles: task.result?.changedFiles ?? [],
					verificationIds: task.result?.verificationIds ?? [],
					risks: [],
					unfinishedItems: [command.reason],
					usage: structuredClone(command.usage),
					durationMs: command.durationMs,
					reason: command.reason,
				},
			},
		});
		return this.#commit(command, events);
	}

	requestCancellation(command: RequestWorkflowCancellationCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		if (workflow.status === "cancelling" || workflow.status === "cancelled") {
			return this.#result(command.workflowId, undefined, false);
		}
		if (isWorkflowTerminalStatus(workflow.status)) {
			fail("controller.workflow_terminal", `Workflow ${workflow.id} is already terminal`);
		}
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: this.#eventId(),
				entityId: workflow.id,
				entityRevision: workflow.revision + 1,
				eventType: "workflow.cancel_requested",
				occurredAt: this.#now(),
				actor: { kind: "user" },
				payload: {
					fromStatus: workflow.status,
					toStatus: "cancelling",
					facts: {
						cancellationRequested: true,
					},
					reason: command.reason,
				},
			},
		];
		return this.#commit(command, events);
	}

	finishCancellation(command: FinishWorkflowCancellationCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const task = this.#requireTask(command.taskId, command.workflowId);
		if (workflow.status === "cancelled") {
			return this.#result(command.workflowId, undefined, false);
		}
		if (workflow.status !== "cancelling") {
			fail("controller.not_cancelling", `Workflow ${workflow.id} is not cancelling`);
		}
		assertValidUsage(command.usage);
		if (command.attemptUsage) {
			assertValidUsage(command.attemptUsage);
		}
		assertValidDuration(command.durationMs);

		const occurredAt = this.#now();
		const events: WorkflowEventDraft[] = [];
		let causationId: string | undefined;
		const attempt = task.currentAttemptId ? this.#store.getAttempt(task.currentAttemptId) : undefined;
		if (attempt && !isAttemptTerminalStatus(attempt.status)) {
			causationId = this.#eventId();
			events.push({
				eventId: causationId,
				entityId: attempt.id,
				entityRevision: attempt.revision + 1,
				eventType: "attempt.cancelled",
				occurredAt,
				actor: { kind: "controller" },
				payload: {
					fromStatus: attempt.status,
					toStatus: "cancelled",
					endedAt: occurredAt,
					usage: structuredClone(command.attemptUsage ?? command.usage),
					reason: command.reason,
				},
			});
		}
		if (!isTaskTerminalStatus(task.status)) {
			const taskCancelledId = this.#eventId();
			events.push({
				eventId: taskCancelledId,
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.cancelled",
				occurredAt,
				actor: { kind: "controller" },
				causationId,
				payload: {
					fromStatus: task.status,
					toStatus: "cancelled",
					facts: {
						activeAttemptStopped: true,
					},
					reason: command.reason,
				},
			});
			causationId = taskCancelledId;
		}
		events.push({
			eventId: this.#eventId(),
			entityId: workflow.id,
			entityRevision: workflow.revision + 1,
			eventType: "workflow.cancelled",
			occurredAt,
			actor: { kind: "controller" },
			causationId,
			payload: {
				fromStatus: workflow.status,
				toStatus: "cancelled",
				facts: {
					runtimeResourcesStopped: command.runtimeResourcesStopped,
					writerLeaseReleased: command.writerLeaseReleased,
				},
				result: {
					status: "cancelled",
					summary: command.reason,
					completedTaskIds: task.status === "succeeded" ? [task.id] : [],
					failedTaskIds: [],
					changedFiles: task.result?.changedFiles ?? [],
					verificationIds: task.result?.verificationIds ?? [],
					risks: [],
					unfinishedItems: [command.reason],
					usage: structuredClone(command.usage),
					durationMs: command.durationMs,
					reason: command.reason,
				},
			},
		});
		return this.#commit(command, events);
	}

	getWorkflow(workflowId: WorkflowId): Workflow | undefined {
		return this.#store.getWorkflow(workflowId);
	}

	getRootTask(workflowId: WorkflowId): Task | undefined {
		const workflow = this.#store.getWorkflow(workflowId);
		return workflow?.rootTaskId ? this.#store.getTask(workflow.rootTaskId) : undefined;
	}

	listAttempts(taskId: TaskId): readonly Attempt[] {
		return this.#store.listAttempts(taskId);
	}

	getVerification(verificationId: VerificationId): VerificationResult | undefined {
		return this.#store.getVerification(verificationId);
	}

	#recordAttemptStarted(event: Extract<DirectRuntimeEvent, { type: "attempt_started" }>): WorkflowCommandResult {
		const workflow = this.#requireWorkflow(event.workflowId);
		const task = this.#requireTask(event.taskId, event.workflowId);
		const attempt = this.#requireAttempt(event.attemptId, event.taskId, event.workflowId);
		if (workflow.status !== "executing" || task.status !== "running" || attempt.status !== "queued") {
			fail(
				"controller.attempt_not_startable",
				`Attempt ${attempt.id} cannot start while workflow is ${workflow.status}, task is ${task.status}, and attempt is ${attempt.status}`,
			);
		}
		const occurredAt = this.#now();
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: this.#eventId(),
				entityId: attempt.id,
				entityRevision: attempt.revision + 1,
				eventType: "attempt.started",
				occurredAt,
				actor: { kind: "agent", id: attempt.agentId ?? "main-agent" },
				payload: {
					fromStatus: attempt.status,
					toStatus: "running",
					startedAt: attempt.startedAt ?? occurredAt,
				},
			},
		];
		return this.#commit(event, events);
	}

	#recordAttemptSucceeded(event: Extract<DirectRuntimeEvent, { type: "attempt_succeeded" }>): WorkflowCommandResult {
		const workflow = this.#requireWorkflow(event.workflowId);
		const task = this.#requireTask(event.taskId, event.workflowId);
		const attempt = this.#requireAttempt(event.attemptId, event.taskId, event.workflowId);
		if (workflow.status !== "executing" || task.status !== "running" || attempt.status !== "running") {
			fail(
				"controller.attempt_not_running",
				`Attempt ${attempt.id} cannot succeed while workflow is ${workflow.status}, task is ${task.status}, and attempt is ${attempt.status}`,
			);
		}
		assertValidUsage(event.usage);
		const requirement = event.requirementId
			? task.verificationRequirements.find((candidate) => candidate.id === event.requirementId)
			: task.verificationRequirements.find((candidate) => candidate.required);
		if (!requirement) {
			fail(
				"controller.verification_requirement_missing",
				event.requirementId
					? `Verification requirement ${event.requirementId} does not exist on task ${task.id}`
					: `Task ${task.id} has no required verification`,
			);
		}
		if (this.#store.getVerification(event.verificationId)) {
			fail("controller.verification_exists", `Verification ${event.verificationId} already exists`);
		}

		const occurredAt = this.#now();
		const attemptSucceededId = this.#eventId();
		const taskVerifyingId = this.#eventId();
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: attemptSucceededId,
				entityId: attempt.id,
				entityRevision: attempt.revision + 1,
				eventType: "attempt.succeeded",
				occurredAt,
				actor: { kind: "agent", id: attempt.agentId ?? "main-agent" },
				payload: {
					fromStatus: attempt.status,
					toStatus: "succeeded",
					endedAt: occurredAt,
					usage: structuredClone(event.usage),
				},
			},
			{
				eventId: taskVerifyingId,
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.verification_started",
				occurredAt,
				actor: { kind: "controller" },
				causationId: attemptSucceededId,
				payload: {
					fromStatus: task.status,
					toStatus: "verifying",
					facts: {
						attemptSucceeded: true,
						hasRequiredVerification: true,
					},
					verificationRequirementIds: [requirement.id],
				},
			},
			{
				eventId: this.#eventId(),
				entityId: event.verificationId,
				entityRevision: 0,
				eventType: "verification.started",
				occurredAt,
				actor: { kind: "controller" },
				causationId: taskVerifyingId,
				payload: {
					result: {
						id: event.verificationId,
						workflowId: event.workflowId,
						taskId: task.id,
						requirementId: requirement.id,
						status: "running",
						summary: event.summary,
						evidenceRefs: structuredClone(event.evidenceRefs ?? []),
						startedAt: occurredAt,
					},
				},
			},
		];
		return this.#commit(event, events);
	}

	#recordAttemptFailed(event: Extract<DirectRuntimeEvent, { type: "attempt_failed" }>): WorkflowCommandResult {
		const workflow = this.#requireWorkflow(event.workflowId);
		const task = this.#requireTask(event.taskId, event.workflowId);
		const attempt = this.#requireAttempt(event.attemptId, event.taskId, event.workflowId);
		if (workflow.status !== "executing" || task.status !== "running" || attempt.status !== "running") {
			fail(
				"controller.attempt_not_running",
				`Attempt ${attempt.id} cannot fail while workflow is ${workflow.status}, task is ${task.status}, and attempt is ${attempt.status}`,
			);
		}
		assertValidUsage(event.usage);
		if (event.workflowUsage) {
			assertValidUsage(event.workflowUsage);
		}
		const workflowUsage = event.workflowUsage ?? event.usage;
		const occurredAt = this.#now();
		const attemptFailedId = this.#eventId();
		const events: WorkflowEventDraft[] = [
			{
				eventId: attemptFailedId,
				entityId: attempt.id,
				entityRevision: attempt.revision + 1,
				eventType: "attempt.failed",
				occurredAt,
				actor: { kind: "agent", id: attempt.agentId ?? "main-agent" },
				payload: {
					fromStatus: attempt.status,
					toStatus: "failed",
					endedAt: occurredAt,
					usage: structuredClone(event.usage),
					failure: {
						...structuredClone(event.failure),
						retryable: event.willRetry,
					},
					willRetry: event.willRetry,
				},
			},
		];
		if (event.willRetry) {
			const dependenciesSucceeded = task.dependencyIds.every(
				(dependencyId) => this.#store.getTask(dependencyId)?.status === "succeeded",
			);
			events.push({
				eventId: this.#eventId(),
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.ready",
				occurredAt,
				actor: { kind: "controller" },
				causationId: attemptFailedId,
				payload: {
					fromStatus: task.status,
					toStatus: "ready",
					facts: {
						workflowExecuting: workflow.status === "executing",
						dependenciesSucceeded,
						retryAllowed: true,
					},
				},
			});
		} else {
			const taskFailedId = this.#eventId();
			events.push(
				{
					eventId: taskFailedId,
					entityId: task.id,
					entityRevision: task.revision + 1,
					eventType: "task.failed",
					occurredAt,
					actor: { kind: "controller" },
					causationId: attemptFailedId,
					payload: {
						fromStatus: task.status,
						toStatus: "failed",
						facts: {
							failureTerminalCondition: true,
							activeAttemptStopped: true,
						},
						reason: event.failure.message,
					},
				},
				{
					eventId: this.#eventId(),
					entityId: workflow.id,
					entityRevision: workflow.revision + 1,
					eventType: "workflow.failed",
					occurredAt,
					actor: { kind: "controller" },
					causationId: taskFailedId,
					payload: {
						fromStatus: workflow.status,
						toStatus: "failed",
						facts: {
							failureTerminalCondition: true,
							runtimeResourcesStopped: true,
						},
						result: {
							status: "failed",
							summary: event.failure.message,
							completedTaskIds: [],
							failedTaskIds: [task.id],
							changedFiles: [],
							verificationIds: [],
							risks: [],
							unfinishedItems: [event.failure.message],
							usage: structuredClone(workflowUsage),
							durationMs: workflowUsage.durationMs,
							reason: event.failure.message,
						},
					},
				},
			);
		}
		return this.#commit(event, events);
	}

	#duplicateResult(command: WorkflowCommandBase): WorkflowCommandResult | undefined {
		const persisted = this.#eventLog.findByCommand(command.workflowId, command.commandId);
		if (!persisted) {
			return undefined;
		}
		this.#store.apply(persisted);
		return this.#result(command.workflowId, persisted.batch.batchId, false);
	}

	#commit(command: WorkflowCommandBase, events: readonly WorkflowEventDraft[]): WorkflowCommandResult {
		const batch = createWorkflowEventBatch({
			batchId: this.#createId("batch"),
			workflowId: command.workflowId,
			commandId: command.commandId,
			correlationId: command.correlationId ?? command.commandId,
			expectedLastSequence: this.#store.getLastSequence(command.workflowId),
			events,
		});
		const persisted = this.#eventLog.append(batch);
		const applied = this.#store.apply(persisted);
		return this.#result(command.workflowId, persisted.batch.batchId, applied);
	}

	#result(workflowId: WorkflowId, batchId: string | undefined, applied: boolean): WorkflowCommandResult {
		const workflow = this.#requireWorkflow(workflowId);
		const result: WorkflowCommandResult = {
			applied,
			workflow,
			rootTask: workflow.rootTaskId ? this.#store.getTask(workflow.rootTaskId) : undefined,
		};
		return batchId ? { ...result, batchId } : result;
	}

	#requireWorkflow(workflowId: WorkflowId): Workflow {
		const workflow = this.#store.getWorkflow(workflowId);
		if (!workflow) {
			fail("controller.workflow_missing", `Workflow ${workflowId} does not exist`);
		}
		return workflow;
	}

	#requireTask(taskId: TaskId, workflowId: WorkflowId): Task {
		const task = this.#store.getTask(taskId);
		if (!task || task.workflowId !== workflowId) {
			fail("controller.task_missing", `Task ${taskId} does not exist in workflow ${workflowId}`);
		}
		return task;
	}

	#requireAttempt(attemptId: AttemptId, taskId: TaskId, workflowId: WorkflowId): Attempt {
		const attempt = this.#store.getAttempt(attemptId);
		if (!attempt || attempt.taskId !== taskId || attempt.workflowId !== workflowId) {
			fail("controller.attempt_missing", `Attempt ${attemptId} does not belong to task ${taskId}`);
		}
		return attempt;
	}

	#eventId(): string {
		return this.#createId("event");
	}
}
