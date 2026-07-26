import { randomUUID } from "crypto";
import { BUILTIN_AGENT_PROFILES } from "./agent-profile.ts";
import { type UpgradeDirectToPlanDecision, validateDirectPlanUpgradeReadiness } from "./direct-plan-upgrade.ts";
import type { SessionWorkflowEventLog } from "./event-log.ts";
import type { WorkflowEventDraft } from "./events.ts";
import { createWorkflowEventBatch } from "./events.ts";
import { validatePlan } from "./invariants.ts";
import { createModeDecision } from "./mode-decision.ts";
import { selectExecutionMode } from "./mode-selector.ts";
import { assertBudgetAvailable, inheritBudgetLimits } from "./runtime-policy.ts";
import { deriveTaskReadiness } from "./scheduler.ts";
import type { WorkflowStore } from "./stores.ts";
import { isAttemptTerminalStatus, isTaskTerminalStatus, isWorkflowTerminalStatus } from "./transitions.ts";
import type {
	Attempt,
	AttemptId,
	BudgetLimit,
	CommandId,
	CorrelationId,
	FailureRecord,
	FileModificationRecord,
	IsoDateTime,
	Plan,
	PlanContent,
	PlanDecisionRecord,
	PlanId,
	ResourceUsage,
	Task,
	TaskAssignment,
	TaskBlockedReason,
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

export interface StartPlanWorkflowCommand extends WorkflowCommandBase {
	readonly rootTaskId: TaskId;
	readonly planId: PlanId;
	readonly request: UserRequest;
	readonly title?: string;
	readonly description?: string;
	readonly budget?: BudgetLimit;
}

export interface SubmitPlanForApprovalCommand extends WorkflowCommandBase {
	readonly planId: PlanId;
	readonly content: PlanContent;
	readonly plannerReadOnly: boolean;
}

export interface ApprovePlanCommand extends WorkflowCommandBase {
	readonly planId: PlanId;
	readonly comment: string;
}

export interface RejectPlanCommand extends WorkflowCommandBase {
	readonly planId: PlanId;
	readonly comment: string;
}

export interface RevisePlanCommand extends WorkflowCommandBase {
	readonly planId: PlanId;
	readonly replacementPlanId: PlanId;
	readonly comment: string;
}

export interface MarkTaskReadyCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly blockResolved?: boolean;
}

export interface PrepareMainAgentAttemptCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly agentId?: string;
	readonly writerLeaseId?: string;
}

export interface PrepareTaskAttemptCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly assignment: TaskAssignment;
	readonly writerLeaseId?: string;
}

export interface RefreshTaskReadinessCommand extends WorkflowCommandBase {}

export interface RetryTaskCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
}

export interface BlockTaskCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly reason: TaskBlockedReason;
}

export interface CancelTaskCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly reason: string;
}

export interface RecordTaskModificationCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly modification: Omit<FileModificationRecord, "workflowId" | "taskId" | "recordedAt">;
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

export interface CompleteTaskCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly verificationId: VerificationId;
	readonly summary: string;
	readonly changedFiles: readonly string[];
	readonly evidenceRefs?: readonly string[];
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

export interface RequestDirectPlanUpgradeCommand extends WorkflowCommandBase {
	readonly decision: UpgradeDirectToPlanDecision;
}

export interface FinishDirectPlanUpgradeCommand extends WorkflowCommandBase {
	readonly taskId: TaskId;
	readonly planId: PlanId;
	readonly attemptUsage?: ResourceUsage;
	readonly writeAdmissionClosed: boolean;
	readonly activeWriterStopped: boolean;
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

export type WorkflowControllerIdKind = "batch" | "event" | "task";

export interface WorkflowControllerOptions {
	readonly createId?: (kind: WorkflowControllerIdKind) => string;
	readonly now?: () => IsoDateTime;
}

export interface WorkflowCommandResult {
	readonly applied: boolean;
	readonly batchId?: string;
	readonly workflow: Workflow;
	readonly rootTask?: Task;
	readonly currentPlan?: Plan;
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

function addUsage(left: ResourceUsage, right: ResourceUsage): ResourceUsage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
		cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
		cost: left.cost + right.cost,
		turns: left.turns + right.turns,
		durationMs: left.durationMs + right.durationMs,
	};
}

function fail(code: string, message: string): never {
	throw new WorkflowControllerError(code, message);
}

function orderedPlanSteps(plan: Plan): Plan["steps"] {
	const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
	const visited = new Set<string>();
	const ordered: Plan["steps"][number][] = [];
	const visit = (stepId: string): void => {
		if (visited.has(stepId)) {
			return;
		}
		const step = stepsById.get(stepId);
		if (!step) {
			fail("controller.plan_step_missing", `Plan step ${stepId} does not exist`);
		}
		for (const dependencyId of step.dependsOn) {
			visit(dependencyId);
		}
		visited.add(stepId);
		ordered.push(step);
	};
	for (const step of plan.steps) {
		visit(step.id);
	}
	return ordered;
}

function createPlanDecision(
	action: PlanDecisionRecord["action"],
	comment: string,
	decidedAt: IsoDateTime,
): PlanDecisionRecord {
	const normalizedComment = comment.trim();
	if (!normalizedComment) {
		fail("controller.plan_decision_comment_required", "Plan decision comment is required");
	}
	return {
		action,
		comment: normalizedComment,
		decidedAt,
	};
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
		const modeSelection = selectExecutionMode({ requestedMode: command.request.requestedMode });
		if (modeSelection.mode !== "direct") {
			fail("controller.mode_conflict", "A Direct workflow cannot override an explicit Plan mode request");
		}
		const requirements = structuredClone(command.verificationRequirements ?? [DEFAULT_COMPLETION_REQUIREMENT]);
		if (requirements.filter((requirement) => requirement.required).length !== 1) {
			fail("controller.verification_required", "M1 Direct workflow requires exactly one required verification");
		}

		const occurredAt = this.#now();
		const budget = structuredClone(command.budget ?? {});
		const modeDecision = createModeDecision({
			selection: modeSelection,
			reason:
				modeSelection.source === "user"
					? "User explicitly selected Direct mode"
					: "No explicit mode or Agent recommendation was available; using the Direct default",
			riskLevel: "low",
			decidedAt: occurredAt,
		});
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
			accessMode: "writer",
			title: command.title?.trim() || "Direct request",
			description: command.description?.trim() || command.request.text,
			status: "pending",
			dependencyIds: [],
			budget: inheritBudgetLimits(budget, BUILTIN_AGENT_PROFILES.worker.defaultBudget),
			usage: zeroUsage(),
			attemptIds: [],
			verificationRequirements: requirements,
			modifications: [],
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
					decision: modeDecision,
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

	startPlan(command: StartPlanWorkflowCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		if (this.#store.getWorkflow(command.workflowId)) {
			fail("controller.workflow_exists", `Workflow ${command.workflowId} already exists`);
		}
		if (this.#store.getPlan(command.planId)) {
			fail("controller.plan_exists", `Plan ${command.planId} already exists`);
		}
		const modeSelection = selectExecutionMode({ requestedMode: "plan" });
		const occurredAt = this.#now();
		const budget = structuredClone(command.budget ?? {});
		const workflow: Workflow = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: 0,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			id: command.workflowId,
			status: "received",
			request: {
				...structuredClone(command.request),
				requestedMode: "plan",
			},
			rootTaskId: command.rootTaskId,
			budget,
			usage: zeroUsage(),
		};
		const rootTask: Task = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: 0,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			id: command.rootTaskId,
			workflowId: command.workflowId,
			kind: "control",
			accessMode: "read_only",
			title: command.title?.trim() || "Plan workflow",
			description: command.description?.trim() || command.request.text,
			status: "pending",
			dependencyIds: [],
			budget: inheritBudgetLimits(budget, BUILTIN_AGENT_PROFILES.planner.defaultBudget),
			usage: zeroUsage(),
			attemptIds: [],
			verificationRequirements: [],
			modifications: [],
		};
		const plan: Plan = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: 0,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			id: command.planId,
			workflowId: command.workflowId,
			version: 1,
			status: "draft",
			goal: "",
			assumptions: [],
			steps: [],
			risks: [],
			verificationRequirements: [],
			decisionHistory: [],
		};
		const workflowCreatedId = this.#eventId();
		const modeDecidedId = this.#eventId();
		const taskCreatedId = this.#eventId();
		const planCreatedId = this.#eventId();
		const planSelectedId = this.#eventId();
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
					decision: createModeDecision({
						selection: modeSelection,
						reason: "User selected Plan mode",
						riskLevel: "low",
						decidedAt: occurredAt,
					}),
				},
			},
			{
				eventId: taskCreatedId,
				entityId: rootTask.id,
				entityRevision: 0,
				eventType: "task.created",
				occurredAt,
				actor: { kind: "controller" },
				causationId: modeDecidedId,
				payload: { task: rootTask },
			},
			{
				eventId: planCreatedId,
				entityId: plan.id,
				entityRevision: 0,
				eventType: "plan.created",
				occurredAt,
				actor: { kind: "controller" },
				causationId: taskCreatedId,
				payload: { plan },
			},
			{
				eventId: planSelectedId,
				entityId: workflow.id,
				entityRevision: 2,
				eventType: "workflow.plan_selected",
				occurredAt,
				actor: { kind: "controller" },
				causationId: planCreatedId,
				payload: { planId: plan.id },
			},
			{
				eventId: this.#eventId(),
				entityId: workflow.id,
				entityRevision: 3,
				eventType: "workflow.status_changed",
				occurredAt,
				actor: { kind: "controller" },
				causationId: planSelectedId,
				payload: {
					fromStatus: "received",
					toStatus: "planning",
					facts: {
						planModeSelected: true,
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

	refreshTaskReadiness(command: RefreshTaskReadinessCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		if (workflow.status !== "executing") {
			fail("controller.workflow_not_executing", `Workflow ${workflow.id} is not executing`);
		}
		const tasks = this.#store.listTasks(workflow.id);
		const readiness = deriveTaskReadiness(tasks);
		if (readiness.readyTaskIds.length === 0 && readiness.blockedTasks.length === 0) {
			return this.#result(workflow.id, undefined, false);
		}
		const occurredAt = this.#now();
		const readyEvents: WorkflowEventDraft[] = readiness.readyTaskIds.map((taskId) => {
			const task = this.#requireTask(taskId, workflow.id);
			return {
				eventId: this.#eventId(),
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.ready",
				occurredAt,
				actor: { kind: "controller" },
				payload: {
					fromStatus: task.status,
					toStatus: "ready",
					facts: {
						workflowExecuting: true,
						dependenciesSucceeded: true,
					},
				},
			};
		});
		const blockedEvents: WorkflowEventDraft[] = readiness.blockedTasks.map(({ taskId, dependencyIds }) => {
			const task = this.#requireTask(taskId, workflow.id);
			return {
				eventId: this.#eventId(),
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.blocked",
				occurredAt,
				actor: { kind: "controller" },
				payload: {
					fromStatus: task.status,
					toStatus: "blocked",
					facts: {
						blockedReasonPresent: true,
					},
					reason: {
						code: "dependency_failed",
						message: `Dependencies did not succeed: ${dependencyIds.join(", ")}`,
						since: occurredAt,
						resumeStatus: "pending",
					},
				},
			};
		});
		return this.#commit(command, [...readyEvents, ...blockedEvents]);
	}

	retryTask(command: RetryTaskCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		if (workflow.status !== "executing") {
			fail("controller.workflow_not_executing", `Workflow ${workflow.id} is not executing`);
		}
		const task = this.#requireTask(command.taskId, workflow.id);
		if (task.status === "ready") {
			return this.#result(workflow.id, undefined, false);
		}
		if (task.status !== "blocked") {
			fail("controller.task_not_retryable", `Task ${task.id} must be blocked before it can be retried`);
		}
		const dependenciesSucceeded = task.dependencyIds.every(
			(dependencyId) => this.#store.getTask(dependencyId)?.status === "succeeded",
		);
		if (!dependenciesSucceeded) {
			fail("controller.task_dependencies_incomplete", `Task ${task.id} still has incomplete dependencies`);
		}
		const event: WorkflowEventDraft = {
			eventId: this.#eventId(),
			entityId: task.id,
			entityRevision: task.revision + 1,
			eventType: "task.ready",
			occurredAt: this.#now(),
			actor: { kind: "user" },
			payload: {
				fromStatus: task.status,
				toStatus: "ready",
				facts: {
					workflowExecuting: true,
					dependenciesSucceeded: true,
					blockResolved: true,
				},
			},
		};
		return this.#commit(command, [event]);
	}

	blockTask(command: BlockTaskCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		if (workflow.status !== "executing") {
			fail("controller.workflow_not_executing", `Workflow ${workflow.id} is not executing`);
		}
		const task = this.#requireTask(command.taskId, workflow.id);
		if (task.status === "blocked") {
			return this.#result(workflow.id, undefined, false);
		}
		if (task.status !== "pending" && task.status !== "ready") {
			fail("controller.task_not_blockable", `Task ${task.id} must be pending or ready before it can be blocked`);
		}
		const event: WorkflowEventDraft = {
			eventId: this.#eventId(),
			entityId: task.id,
			entityRevision: task.revision + 1,
			eventType: "task.blocked",
			occurredAt: this.#now(),
			actor: { kind: "controller" },
			payload: {
				fromStatus: task.status,
				toStatus: "blocked",
				facts: {
					blockedReasonPresent: true,
				},
				reason: structuredClone(command.reason),
			},
		};
		return this.#commit(command, [event]);
	}

	cancelTask(command: CancelTaskCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		if (workflow.status !== "executing") {
			fail("controller.workflow_not_executing", `Workflow ${workflow.id} is not executing`);
		}
		const task = this.#requireTask(command.taskId, workflow.id);
		if (isTaskTerminalStatus(task.status)) {
			return this.#result(workflow.id, undefined, false);
		}
		if (task.status === "running" || task.status === "verifying") {
			fail("controller.task_attempt_active", `Task ${task.id} must stop its active attempt before cancellation`);
		}
		const reason = command.reason.trim();
		if (!reason) {
			fail("controller.task_cancel_reason_required", "Task cancellation requires a reason");
		}
		const event: WorkflowEventDraft = {
			eventId: this.#eventId(),
			entityId: task.id,
			entityRevision: task.revision + 1,
			eventType: "task.cancelled",
			occurredAt: this.#now(),
			actor: { kind: "user" },
			payload: {
				fromStatus: task.status,
				toStatus: "cancelled",
				facts: {
					activeAttemptStopped: true,
				},
				reason,
			},
		};
		return this.#commit(command, [event]);
	}

	recordTaskModification(command: RecordTaskModificationCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const task = this.#requireTask(command.taskId, command.workflowId);
		const attempt = this.#requireAttempt(command.modification.attemptId, task.id, command.workflowId);
		if (task.status !== "running" || attempt.status !== "running") {
			fail("controller.modification_not_running", "Modifications require a running Task and Attempt");
		}
		if (task.accessMode !== "writer") {
			fail("controller.modification_read_only", `Read-only Task ${task.id} cannot record modifications`);
		}
		const occurredAt = this.#now();
		const modification: FileModificationRecord = {
			...structuredClone(command.modification),
			workflowId: command.workflowId,
			taskId: task.id,
			recordedAt: occurredAt,
		};
		const event: WorkflowEventDraft = {
			eventId: this.#eventId(),
			entityId: task.id,
			entityRevision: task.revision + 1,
			eventType: "task.modification_recorded",
			occurredAt,
			actor: { kind: "agent", id: modification.agentId },
			payload: { modification },
		};
		return this.#commit(command, [event]);
	}

	prepareMainAgentAttempt(command: PrepareMainAgentAttemptCommand): WorkflowCommandResult {
		return this.prepareTaskAttempt({
			...command,
			assignment: {
				executorKind: "main_agent",
				agentId: command.agentId,
			},
		});
	}

	prepareTaskAttempt(command: PrepareTaskAttemptCommand): WorkflowCommandResult {
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
		if (task.kind === "control") {
			fail("controller.control_task_not_executable", `Control Task ${task.id} cannot create an attempt`);
		}
		if (task.accessMode === "writer" && !command.writerLeaseId?.trim()) {
			fail("controller.writer_lease_required", `Writer Task ${task.id} requires an active Writer Lease`);
		}
		if (task.kind === "command" && command.assignment.executorKind !== "job") {
			fail("controller.executor_mismatch", `Command Task ${task.id} requires a Job executor`);
		}
		if ((task.kind === "agent" || task.kind === "repair") && command.assignment.executorKind === "job") {
			fail("controller.executor_mismatch", `Agent Task ${task.id} requires an Agent executor`);
		}
		if (
			command.assignment.agentDepth !== undefined &&
			(!Number.isInteger(command.assignment.agentDepth) || command.assignment.agentDepth < 0)
		) {
			fail("controller.invalid_agent_depth", "Agent depth must be a non-negative integer");
		}
		if (this.#store.getAttempt(command.attemptId)) {
			fail("controller.attempt_exists", `Attempt ${command.attemptId} already exists`);
		}
		const attempts = this.#store.listAttempts(task.id);
		const taskUsage = attempts.reduce((usage, attempt) => addUsage(usage, attempt.usage), task.usage);
		assertBudgetAvailable(task.budget, taskUsage, {
			retries: attempts.length,
		});
		const workflowTasks = this.#store.listTasks(workflow.id);
		const activeAssignments = workflowTasks
			.filter(({ status }) => status === "running" || status === "verifying")
			.map(({ assignment }) => assignment)
			.filter((assignment): assignment is TaskAssignment => assignment !== undefined);
		const requestedAgent =
			command.assignment.executorKind === "main_agent" || command.assignment.executorKind === "subagent";
		const requestedJob = command.assignment.executorKind === "job";
		const workflowUsage = workflowTasks
			.flatMap(({ id }) => this.#store.listAttempts(id))
			.reduce((usage, attempt) => addUsage(usage, attempt.usage), workflow.usage);
		assertBudgetAvailable(workflow.budget, workflowUsage, {
			activeAgents:
				activeAssignments.filter(({ executorKind }) => executorKind === "main_agent" || executorKind === "subagent")
					.length + (requestedAgent ? 1 : 0),
			activeJobs:
				activeAssignments.filter(({ executorKind }) => executorKind === "job").length + (requestedJob ? 1 : 0),
			agentDepth: command.assignment.agentDepth ?? 0,
		});

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
			executorKind: command.assignment.executorKind,
			agentId: command.assignment.agentId,
			jobId: command.assignment.jobId,
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
					assignment: structuredClone(command.assignment),
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
						writerLeaseRequired: task.accessMode === "writer",
						writerLeaseHeld: task.accessMode === "writer" ? Boolean(command.writerLeaseId) : undefined,
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

	completeTask(command: CompleteTaskCommand): WorkflowCommandResult {
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
			fail("controller.task_not_ready_to_complete", `Task ${task.id} is not ready for completion`);
		}
		const occurredAt = this.#now();
		const verificationPassedId = this.#eventId();
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
				eventId: this.#eventId(),
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
		];
		return this.#commit(command, events);
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

	submitPlanForApproval(command: SubmitPlanForApprovalCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const plan = this.#requirePlan(command.planId, command.workflowId);
		if (
			workflow.status !== "planning" ||
			workflow.currentPlanId !== plan.id ||
			workflow.modeDecision?.mode !== "plan" ||
			plan.status !== "draft"
		) {
			fail("controller.plan_not_submittable", `Plan ${plan.id} is not the active Draft Plan`);
		}
		const latestPlan = this.#store.listPlans(workflow.id).at(-1);
		const candidate: Plan = {
			...plan,
			...structuredClone(command.content),
			status: "awaiting_approval",
			revision: plan.revision + 2,
			updatedAt: this.#now(),
		};
		const violations = validatePlan(candidate);
		if (violations.length > 0) {
			fail("controller.plan_invalid", violations.map(({ message }) => message).join("; "));
		}
		if (!command.plannerReadOnly) {
			fail("controller.planner_write_detected", "Planner must remain read-only before requesting approval");
		}

		const occurredAt = candidate.updatedAt;
		const contentUpdatedId = this.#eventId();
		const approvalRequestedId = this.#eventId();
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: contentUpdatedId,
				entityId: plan.id,
				entityRevision: plan.revision + 1,
				eventType: "plan.content_updated",
				occurredAt,
				actor: { kind: "agent", id: "planner" },
				payload: {
					content: structuredClone(command.content),
				},
			},
			{
				eventId: approvalRequestedId,
				entityId: plan.id,
				entityRevision: plan.revision + 2,
				eventType: "plan.awaiting_approval",
				occurredAt,
				actor: { kind: "controller" },
				causationId: contentUpdatedId,
				payload: {
					fromStatus: plan.status,
					toStatus: "awaiting_approval",
					facts: {
						structureValid: true,
						latestVersion: latestPlan?.id === plan.id,
						readOnly: command.plannerReadOnly,
					},
				},
			},
			{
				eventId: this.#eventId(),
				entityId: workflow.id,
				entityRevision: workflow.revision + 1,
				eventType: "workflow.status_changed",
				occurredAt,
				actor: { kind: "controller" },
				causationId: approvalRequestedId,
				payload: {
					fromStatus: workflow.status,
					toStatus: "awaiting_approval",
					facts: {
						planReady: true,
						planReadOnly: command.plannerReadOnly,
					},
				},
			},
		];
		return this.#commit(command, events);
	}

	approvePlan(command: ApprovePlanCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const plan = this.#requirePlan(command.planId, command.workflowId);
		if (
			workflow.status !== "awaiting_approval" ||
			workflow.currentPlanId !== plan.id ||
			plan.status !== "awaiting_approval"
		) {
			fail("controller.plan_not_awaiting_approval", `Plan ${plan.id} is not awaiting approval`);
		}
		const rootTask = workflow.rootTaskId
			? this.#requireTask(workflow.rootTaskId, workflow.id)
			: fail("controller.root_task_missing", `Workflow ${workflow.id} has no root task`);
		const occurredAt = this.#now();
		const decision = createPlanDecision("approved", command.comment, occurredAt);
		const stepTaskIds = new Map(plan.steps.map((step) => [step.id, this.#createId("task")]));
		const planApprovedId = this.#eventId();
		const events: WorkflowEventDraft[] = [
			{
				eventId: planApprovedId,
				entityId: plan.id,
				entityRevision: plan.revision + 1,
				eventType: "plan.approved",
				occurredAt,
				actor: { kind: "user" },
				payload: {
					fromStatus: plan.status,
					toStatus: "approved",
					facts: {},
					decision,
				},
			},
		];
		let causationId = planApprovedId;
		for (const step of orderedPlanSteps(plan)) {
			const taskId = stepTaskIds.get(step.id);
			if (!taskId) {
				fail("controller.plan_step_task_missing", `Plan step ${step.id} has no Task id`);
			}
			const task: Task = {
				schemaVersion: WORKFLOW_SCHEMA_VERSION,
				revision: 0,
				createdAt: occurredAt,
				updatedAt: occurredAt,
				id: taskId,
				workflowId: workflow.id,
				parentTaskId: rootTask.id,
				sourcePlanId: plan.id,
				sourcePlanStepId: step.id,
				kind: "agent",
				accessMode: step.fileIntents.some(({ action }) => action !== "inspect") ? "writer" : "read_only",
				title: step.title,
				description: step.description,
				status: "pending",
				dependencyIds: step.dependsOn.map((dependencyId) => {
					const dependencyTaskId = stepTaskIds.get(dependencyId);
					if (!dependencyTaskId) {
						fail("controller.plan_step_dependency_missing", `Plan step ${dependencyId} has no Task id`);
					}
					return dependencyTaskId;
				}),
				budget: inheritBudgetLimits(workflow.budget, BUILTIN_AGENT_PROFILES.worker.defaultBudget),
				usage: zeroUsage(),
				attemptIds: [],
				verificationRequirements: plan.verificationRequirements
					.filter((requirement) => step.verificationRequirementIds.includes(requirement.id))
					.map((requirement) => structuredClone(requirement)),
				modifications: [],
			};
			causationId = this.#eventId();
			events.push({
				eventId: causationId,
				entityId: task.id,
				entityRevision: 0,
				eventType: "task.created",
				occurredAt,
				actor: { kind: "controller" },
				causationId: planApprovedId,
				payload: { task },
			});
		}
		events.push({
			eventId: this.#eventId(),
			entityId: workflow.id,
			entityRevision: workflow.revision + 1,
			eventType: "workflow.status_changed",
			occurredAt,
			actor: { kind: "controller" },
			causationId,
			payload: {
				fromStatus: workflow.status,
				toStatus: "executing",
				facts: {
					planApproved: true,
					taskGraphReady: plan.steps.length > 0,
				},
			},
		});
		return this.#commit(command, events);
	}

	rejectPlan(command: RejectPlanCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const plan = this.#requirePlan(command.planId, command.workflowId);
		if (
			workflow.status !== "awaiting_approval" ||
			workflow.currentPlanId !== plan.id ||
			plan.status !== "awaiting_approval"
		) {
			fail("controller.plan_not_awaiting_approval", `Plan ${plan.id} is not awaiting approval`);
		}
		const rootTask = workflow.rootTaskId
			? this.#requireTask(workflow.rootTaskId, workflow.id)
			: fail("controller.root_task_missing", `Workflow ${workflow.id} has no root task`);
		const occurredAt = this.#now();
		const decision = createPlanDecision("rejected", command.comment, occurredAt);
		const planRejectedId = this.#eventId();
		const taskCancelledId = this.#eventId();
		const cancelRequestedId = this.#eventId();
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: planRejectedId,
				entityId: plan.id,
				entityRevision: plan.revision + 1,
				eventType: "plan.rejected",
				occurredAt,
				actor: { kind: "user" },
				payload: {
					fromStatus: plan.status,
					toStatus: "rejected",
					facts: {},
					decision,
				},
			},
			{
				eventId: taskCancelledId,
				entityId: rootTask.id,
				entityRevision: rootTask.revision + 1,
				eventType: "task.cancelled",
				occurredAt,
				actor: { kind: "controller" },
				causationId: planRejectedId,
				payload: {
					fromStatus: rootTask.status,
					toStatus: "cancelled",
					facts: {
						activeAttemptStopped: true,
					},
					reason: decision.comment,
				},
			},
			{
				eventId: cancelRequestedId,
				entityId: workflow.id,
				entityRevision: workflow.revision + 1,
				eventType: "workflow.cancel_requested",
				occurredAt,
				actor: { kind: "user" },
				causationId: taskCancelledId,
				payload: {
					fromStatus: workflow.status,
					toStatus: "cancelling",
					facts: {
						cancellationRequested: true,
					},
					reason: decision.comment,
				},
			},
			{
				eventId: this.#eventId(),
				entityId: workflow.id,
				entityRevision: workflow.revision + 2,
				eventType: "workflow.cancelled",
				occurredAt,
				actor: { kind: "controller" },
				causationId: cancelRequestedId,
				payload: {
					fromStatus: "cancelling",
					toStatus: "cancelled",
					facts: {
						runtimeResourcesStopped: true,
						writerLeaseReleased: true,
					},
					result: {
						status: "cancelled",
						summary: decision.comment,
						completedTaskIds: [],
						failedTaskIds: [],
						changedFiles: [],
						verificationIds: [],
						risks: [],
						unfinishedItems: [decision.comment],
						usage: zeroUsage(),
						durationMs: 0,
						reason: decision.comment,
					},
				},
			},
		];
		return this.#commit(command, events);
	}

	revisePlan(command: RevisePlanCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const plan = this.#requirePlan(command.planId, command.workflowId);
		if (
			workflow.status !== "awaiting_approval" ||
			workflow.currentPlanId !== plan.id ||
			plan.status !== "awaiting_approval"
		) {
			fail("controller.plan_not_awaiting_approval", `Plan ${plan.id} is not awaiting approval`);
		}
		if (this.#store.getPlan(command.replacementPlanId)) {
			fail("controller.plan_exists", `Plan ${command.replacementPlanId} already exists`);
		}
		const occurredAt = this.#now();
		const decision = createPlanDecision("revision_requested", command.comment, occurredAt);
		const replacement: Plan = {
			...structuredClone(plan),
			id: command.replacementPlanId,
			version: plan.version + 1,
			supersedesPlanId: plan.id,
			status: "draft",
			revision: 0,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			decisionHistory: [],
		};
		const replacementCreatedId = this.#eventId();
		const supersededId = this.#eventId();
		const planSelectedId = this.#eventId();
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: replacementCreatedId,
				entityId: replacement.id,
				entityRevision: 0,
				eventType: "plan.created",
				occurredAt,
				actor: { kind: "controller" },
				payload: { plan: replacement },
			},
			{
				eventId: supersededId,
				entityId: plan.id,
				entityRevision: plan.revision + 1,
				eventType: "plan.superseded",
				occurredAt,
				actor: { kind: "user" },
				causationId: replacementCreatedId,
				payload: {
					fromStatus: plan.status,
					toStatus: "superseded",
					facts: {
						replacementPlanCreated: true,
					},
					replacementPlanId: replacement.id,
					decision,
				},
			},
			{
				eventId: planSelectedId,
				entityId: workflow.id,
				entityRevision: workflow.revision + 1,
				eventType: "workflow.plan_selected",
				occurredAt,
				actor: { kind: "controller" },
				causationId: supersededId,
				payload: { planId: replacement.id },
			},
			{
				eventId: this.#eventId(),
				entityId: workflow.id,
				entityRevision: workflow.revision + 2,
				eventType: "workflow.status_changed",
				occurredAt,
				actor: { kind: "controller" },
				causationId: planSelectedId,
				payload: {
					fromStatus: workflow.status,
					toStatus: "planning",
					facts: {
						replacementPlanCreated: true,
					},
				},
			},
		];
		return this.#commit(command, events);
	}

	requestDirectPlanUpgrade(command: RequestDirectPlanUpgradeCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		if (workflow.directPlanUpgradeRequest) {
			return this.#result(command.workflowId, undefined, false);
		}
		if (workflow.status !== "executing" || workflow.modeDecision?.mode !== "direct") {
			fail(
				"controller.direct_plan_upgrade_unavailable",
				`Workflow ${workflow.id} cannot request a Direct Plan upgrade while ${workflow.status} in ${workflow.modeDecision?.mode ?? "unresolved"} mode`,
			);
		}
		const request = {
			reason: command.decision.advice.reason,
			riskLevel: command.decision.advice.riskLevel,
			triggers: structuredClone(command.decision.triggers),
			requestedAt: command.decision.evaluatedAt,
		};
		const events: readonly WorkflowEventDraft[] = [
			{
				eventId: this.#eventId(),
				entityId: workflow.id,
				entityRevision: workflow.revision + 1,
				eventType: "workflow.direct_plan_upgrade_requested",
				occurredAt: this.#now(),
				actor: { kind: "controller" },
				payload: { request },
			},
		];
		return this.#commit(command, events);
	}

	finishDirectPlanUpgrade(command: FinishDirectPlanUpgradeCommand): WorkflowCommandResult {
		const duplicate = this.#duplicateResult(command);
		if (duplicate) {
			return duplicate;
		}
		const workflow = this.#requireWorkflow(command.workflowId);
		const task = this.#requireTask(command.taskId, command.workflowId);
		if (workflow.status === "planning" && workflow.currentPlanId) {
			return this.#result(command.workflowId, undefined, false);
		}
		if (
			workflow.status !== "executing" ||
			workflow.modeDecision?.mode !== "direct" ||
			!workflow.directPlanUpgradeRequest
		) {
			fail(
				"controller.direct_plan_upgrade_not_requested",
				`Workflow ${workflow.id} has no active Direct Plan upgrade request`,
			);
		}
		if (isTaskTerminalStatus(task.status)) {
			fail("controller.task_terminal", `Task ${task.id} is already terminal`);
		}
		if (this.#store.getPlan(command.planId)) {
			fail("controller.plan_exists", `Plan ${command.planId} already exists`);
		}
		if (this.#store.listPlans(workflow.id).length > 0) {
			fail("controller.plan_already_created", `Workflow ${workflow.id} already has a Plan`);
		}
		if (command.attemptUsage) {
			assertValidUsage(command.attemptUsage);
		}
		const readinessViolations = validateDirectPlanUpgradeReadiness({
			upgradeRequestPersisted: true,
			writeAdmissionClosed: command.writeAdmissionClosed,
			activeWriterStopped: command.activeWriterStopped,
			draftPlanCreated: true,
		});
		if (readinessViolations.length > 0) {
			const [firstViolation] = readinessViolations;
			fail(firstViolation.code, firstViolation.message);
		}

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
				eventType: "attempt.interrupted",
				occurredAt,
				actor: { kind: "controller" },
				payload: {
					fromStatus: attempt.status,
					toStatus: "interrupted",
					endedAt: occurredAt,
					usage: structuredClone(command.attemptUsage ?? zeroUsage()),
					reason: workflow.directPlanUpgradeRequest.reason,
				},
			});
		}
		if (task.status === "running" || task.status === "verifying") {
			const taskReadyId = this.#eventId();
			events.push({
				eventId: taskReadyId,
				entityId: task.id,
				entityRevision: task.revision + 1,
				eventType: "task.ready",
				occurredAt,
				actor: { kind: "controller" },
				causationId,
				payload: {
					fromStatus: task.status,
					toStatus: "ready",
					facts: {
						workflowExecuting: true,
						dependenciesSucceeded: true,
						retryAllowed: true,
					},
				},
			});
			causationId = taskReadyId;
		}
		const plan: Plan = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: 0,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			id: command.planId,
			workflowId: workflow.id,
			version: 1,
			status: "draft",
			goal: "",
			assumptions: [],
			steps: [],
			risks: [],
			verificationRequirements: [],
			decisionHistory: [],
		};
		const planCreatedId = this.#eventId();
		events.push({
			eventId: planCreatedId,
			entityId: plan.id,
			entityRevision: 0,
			eventType: "plan.created",
			occurredAt,
			actor: { kind: "controller" },
			causationId,
			payload: { plan },
		});
		const planSelectedId = this.#eventId();
		events.push({
			eventId: planSelectedId,
			entityId: workflow.id,
			entityRevision: workflow.revision + 1,
			eventType: "workflow.plan_selected",
			occurredAt,
			actor: { kind: "controller" },
			causationId: planCreatedId,
			payload: { planId: plan.id },
		});
		const modeDecidedId = this.#eventId();
		events.push({
			eventId: modeDecidedId,
			entityId: workflow.id,
			entityRevision: workflow.revision + 2,
			eventType: "workflow.mode_decided",
			occurredAt,
			actor: { kind: "controller" },
			causationId: planSelectedId,
			payload: {
				decision: createModeDecision({
					selection: {
						mode: "plan",
						source: "forced_policy",
					},
					reason: workflow.directPlanUpgradeRequest.reason,
					riskLevel: workflow.directPlanUpgradeRequest.riskLevel,
					decidedAt: occurredAt,
				}),
			},
		});
		events.push({
			eventId: this.#eventId(),
			entityId: workflow.id,
			entityRevision: workflow.revision + 3,
			eventType: "workflow.status_changed",
			occurredAt,
			actor: { kind: "controller" },
			causationId: modeDecidedId,
			payload: {
				fromStatus: workflow.status,
				toStatus: "planning",
				facts: {
					directPlanUpgradeRequested: true,
					writeOperationsStopped: command.activeWriterStopped,
					draftPlanCreated: true,
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
		this.#requireTask(command.taskId, command.workflowId);
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
		const tasks = this.#store.listTasks(workflow.id);
		for (const task of tasks) {
			const attempt = task.currentAttemptId ? this.#store.getAttempt(task.currentAttemptId) : undefined;
			if (attempt && !isAttemptTerminalStatus(attempt.status)) {
				const attemptCancelledId = this.#eventId();
				events.push({
					eventId: attemptCancelledId,
					entityId: attempt.id,
					entityRevision: attempt.revision + 1,
					eventType: "attempt.cancelled",
					occurredAt,
					actor: { kind: "controller" },
					causationId,
					payload: {
						fromStatus: attempt.status,
						toStatus: "cancelled",
						endedAt: occurredAt,
						usage: structuredClone(
							task.id === command.taskId ? (command.attemptUsage ?? command.usage) : attempt.usage,
						),
						reason: command.reason,
					},
				});
				causationId = attemptCancelledId;
			}
			if (isTaskTerminalStatus(task.status)) {
				continue;
			}
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
		const completedTasks = tasks.filter(({ status }) => status === "succeeded");
		const failedTasks = tasks.filter(({ status }) => status === "failed");
		const changedFiles = [...new Set(completedTasks.flatMap(({ result }) => result?.changedFiles ?? []))];
		const verificationIds = [...new Set(completedTasks.flatMap(({ result }) => result?.verificationIds ?? []))];
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
					completedTaskIds: completedTasks.map(({ id }) => id),
					failedTaskIds: failedTasks.map(({ id }) => id),
					changedFiles,
					verificationIds,
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

	getPlan(planId: PlanId): Plan | undefined {
		return this.#store.getPlan(planId);
	}

	getRootTask(workflowId: WorkflowId): Task | undefined {
		const workflow = this.#store.getWorkflow(workflowId);
		return workflow?.rootTaskId ? this.#store.getTask(workflow.rootTaskId) : undefined;
	}

	getTask(taskId: TaskId): Task | undefined {
		return this.#store.getTask(taskId);
	}

	listTasks(workflowId: WorkflowId): readonly Task[] {
		return this.#store.listTasks(workflowId);
	}

	listPlans(workflowId: WorkflowId): readonly Plan[] {
		return this.#store.listPlans(workflowId);
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
			currentPlan: workflow.currentPlanId ? this.#store.getPlan(workflow.currentPlanId) : undefined,
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

	#requirePlan(planId: PlanId, workflowId: WorkflowId): Plan {
		const plan = this.#store.getPlan(planId);
		if (!plan || plan.workflowId !== workflowId) {
			fail("controller.plan_missing", `Plan ${planId} does not exist in workflow ${workflowId}`);
		}
		return plan;
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
