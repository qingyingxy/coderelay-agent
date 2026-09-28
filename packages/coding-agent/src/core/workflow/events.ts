import { validateContextHandoff } from "./context-handoff.ts";
import { validateAttempt, validatePlan, validateTask, validateWorkflow } from "./invariants.ts";
import type {
	DomainViolation,
	PlanTransitionFacts,
	TaskTransitionFacts,
	WorkflowTransitionFacts,
} from "./transitions.ts";
import {
	validateAttemptTransition,
	validatePlanTransition,
	validateTaskTransition,
	validateWorkflowTransition,
} from "./transitions.ts";
import type {
	Attempt,
	AttemptId,
	AttemptStatus,
	CommandId,
	CorrelationId,
	DirectPlanUpgradeRequest,
	EventBatchId,
	EventId,
	FailureRecord,
	FileModificationRecord,
	IsoDateTime,
	ModeDecision,
	Plan,
	PlanContent,
	PlanDecisionRecord,
	PlanId,
	PlanStatus,
	ResourceUsage,
	Task,
	TaskAssignment,
	TaskBlockedReason,
	TaskId,
	TaskResult,
	TaskStatus,
	ToolOperationReceipt,
	VerificationResult,
	Workflow,
	WorkflowBlockedReason,
	WorkflowId,
	WorkflowResult,
	WorkflowStatus,
} from "./types.ts";
import { WORKFLOW_SCHEMA_VERSION } from "./types.ts";

export type WorkflowEntityType = "workflow" | "plan" | "task" | "attempt" | "agent" | "job" | "verification";

export type WorkflowEventActorKind = "user" | "controller" | "agent" | "job" | "system";

export interface WorkflowEventActor {
	readonly kind: WorkflowEventActorKind;
	readonly id?: string;
}

export interface WorkflowStatusChangedPayload {
	readonly fromStatus: WorkflowStatus;
	readonly toStatus: WorkflowStatus;
	readonly facts: WorkflowTransitionFacts;
}

export interface TaskStatusChangedPayload {
	readonly fromStatus: TaskStatus;
	readonly toStatus: TaskStatus;
	readonly facts: TaskTransitionFacts;
}

export interface AttemptStatusChangedPayload {
	readonly fromStatus: AttemptStatus;
	readonly toStatus: AttemptStatus;
}

export interface PlanStatusChangedPayload {
	readonly fromStatus: PlanStatus;
	readonly toStatus: PlanStatus;
	readonly facts: PlanTransitionFacts;
}

export interface WorkflowEventPayloadMap {
	readonly "workflow.created": {
		readonly workflow: Workflow;
	};
	readonly "workflow.mode_decided": {
		readonly decision: ModeDecision;
	};
	readonly "workflow.direct_plan_upgrade_requested": {
		readonly request: DirectPlanUpgradeRequest;
	};
	readonly "workflow.plan_selected": {
		readonly planId: PlanId;
	};
	readonly "workflow.status_changed": WorkflowStatusChangedPayload;
	readonly "workflow.blocked": WorkflowStatusChangedPayload & {
		readonly reason: WorkflowBlockedReason;
	};
	readonly "workflow.unblocked": WorkflowStatusChangedPayload;
	readonly "workflow.cancel_requested": WorkflowStatusChangedPayload & {
		readonly reason: string;
	};
	readonly "workflow.completed": WorkflowStatusChangedPayload & {
		readonly result: WorkflowResult;
	};
	readonly "workflow.failed": WorkflowStatusChangedPayload & {
		readonly result: WorkflowResult;
	};
	readonly "workflow.cancelled": WorkflowStatusChangedPayload & {
		readonly result: WorkflowResult;
	};
	readonly "plan.created": {
		readonly plan: Plan;
	};
	readonly "plan.content_updated": {
		readonly content: PlanContent;
	};
	readonly "plan.awaiting_approval": PlanStatusChangedPayload;
	readonly "plan.approved": PlanStatusChangedPayload & {
		readonly decision: PlanDecisionRecord;
	};
	readonly "plan.rejected": PlanStatusChangedPayload & {
		readonly decision: PlanDecisionRecord;
	};
	readonly "plan.superseded": PlanStatusChangedPayload & {
		readonly replacementPlanId: PlanId;
		readonly decision: PlanDecisionRecord;
	};
	readonly "task.created": {
		readonly task: Task;
	};
	readonly "task.dependency_added": {
		readonly dependencyId: TaskId;
	};
	readonly "task.description_updated": {
		readonly description: string;
	};
	readonly "task.pending": TaskStatusChangedPayload;
	readonly "task.ready": TaskStatusChangedPayload;
	readonly "task.assigned": {
		readonly assignment: TaskAssignment;
	};
	readonly "task.modification_recorded": {
		readonly modification: FileModificationRecord;
	};
	readonly "task.operation_receipt_recorded": {
		readonly receipt: ToolOperationReceipt;
	};
	readonly "task.started": TaskStatusChangedPayload & {
		readonly attemptId: AttemptId;
	};
	readonly "task.verification_started": TaskStatusChangedPayload & {
		readonly verificationRequirementIds: readonly string[];
	};
	readonly "task.blocked": TaskStatusChangedPayload & {
		readonly reason: TaskBlockedReason;
	};
	readonly "task.succeeded": TaskStatusChangedPayload & {
		readonly result: TaskResult;
	};
	readonly "task.failed": TaskStatusChangedPayload & {
		readonly reason: string;
	};
	readonly "task.cancelled": TaskStatusChangedPayload & {
		readonly reason: string;
	};
	readonly "task.skipped": TaskStatusChangedPayload & {
		readonly reason: string;
	};
	readonly "attempt.created": {
		readonly attempt: Attempt;
	};
	readonly "attempt.started": AttemptStatusChangedPayload & {
		readonly startedAt: IsoDateTime;
	};
	readonly "attempt.waiting": AttemptStatusChangedPayload & {
		readonly reason: string;
	};
	readonly "attempt.succeeded": AttemptStatusChangedPayload & {
		readonly endedAt: IsoDateTime;
		readonly usage: ResourceUsage;
	};
	readonly "attempt.failed": AttemptStatusChangedPayload & {
		readonly endedAt: IsoDateTime;
		readonly usage: ResourceUsage;
		readonly failure: FailureRecord;
		readonly willRetry: boolean;
	};
	readonly "attempt.timed_out": AttemptStatusChangedPayload & {
		readonly endedAt: IsoDateTime;
		readonly usage: ResourceUsage;
		readonly timeoutMs: number;
	};
	readonly "attempt.cancelled": AttemptStatusChangedPayload & {
		readonly endedAt: IsoDateTime;
		readonly usage: ResourceUsage;
		readonly reason: string;
	};
	readonly "attempt.interrupted": AttemptStatusChangedPayload & {
		readonly endedAt: IsoDateTime;
		readonly usage: ResourceUsage;
		readonly reason: string;
	};
	readonly "verification.started": {
		readonly result: VerificationResult;
	};
	readonly "verification.passed": {
		readonly result: VerificationResult;
	};
	readonly "verification.failed": {
		readonly result: VerificationResult;
	};
	readonly "verification.skipped": {
		readonly result: VerificationResult;
	};
}

export type WorkflowEventType = keyof WorkflowEventPayloadMap;

export interface WorkflowEvent<TEventType extends WorkflowEventType> {
	readonly schemaVersion: number;
	readonly eventId: EventId;
	readonly workflowId: WorkflowId;
	readonly sequence: number;
	readonly entityType: WorkflowEntityType;
	readonly entityId: string;
	readonly entityRevision: number;
	readonly eventType: TEventType;
	readonly occurredAt: IsoDateTime;
	readonly actor: WorkflowEventActor;
	readonly commandId: CommandId;
	readonly correlationId: CorrelationId;
	readonly causationId?: EventId;
	readonly payload: WorkflowEventPayloadMap[TEventType];
}

export type AnyWorkflowEvent = {
	readonly [TEventType in WorkflowEventType]: WorkflowEvent<TEventType>;
}[WorkflowEventType];

interface WorkflowEventDraftFields {
	readonly eventId: EventId;
	readonly entityId: string;
	readonly entityRevision: number;
	readonly occurredAt: IsoDateTime;
	readonly actor: WorkflowEventActor;
	readonly causationId?: EventId;
}

export type WorkflowEventDraft = {
	readonly [TEventType in WorkflowEventType]: WorkflowEventDraftFields & {
		readonly eventType: TEventType;
		readonly payload: WorkflowEventPayloadMap[TEventType];
	};
}[WorkflowEventType];

export interface WorkflowEventBatch {
	readonly schemaVersion: number;
	readonly batchId: EventBatchId;
	readonly workflowId: WorkflowId;
	readonly commandId: CommandId;
	readonly correlationId: CorrelationId;
	readonly expectedLastSequence: number;
	readonly events: readonly AnyWorkflowEvent[];
}

export interface CreateWorkflowEventBatchInput {
	readonly batchId: EventBatchId;
	readonly workflowId: WorkflowId;
	readonly commandId: CommandId;
	readonly correlationId: CorrelationId;
	readonly expectedLastSequence: number;
	readonly events: readonly WorkflowEventDraft[];
}

const EVENT_ENTITY_TYPES: Readonly<Record<WorkflowEventType, WorkflowEntityType>> = {
	"workflow.created": "workflow",
	"workflow.mode_decided": "workflow",
	"workflow.direct_plan_upgrade_requested": "workflow",
	"workflow.plan_selected": "workflow",
	"workflow.status_changed": "workflow",
	"workflow.blocked": "workflow",
	"workflow.unblocked": "workflow",
	"workflow.cancel_requested": "workflow",
	"workflow.completed": "workflow",
	"workflow.failed": "workflow",
	"workflow.cancelled": "workflow",
	"plan.created": "plan",
	"plan.content_updated": "plan",
	"plan.awaiting_approval": "plan",
	"plan.approved": "plan",
	"plan.rejected": "plan",
	"plan.superseded": "plan",
	"task.created": "task",
	"task.dependency_added": "task",
	"task.description_updated": "task",
	"task.pending": "task",
	"task.ready": "task",
	"task.assigned": "task",
	"task.modification_recorded": "task",
	"task.operation_receipt_recorded": "task",
	"task.started": "task",
	"task.verification_started": "task",
	"task.blocked": "task",
	"task.succeeded": "task",
	"task.failed": "task",
	"task.cancelled": "task",
	"task.skipped": "task",
	"attempt.created": "attempt",
	"attempt.started": "attempt",
	"attempt.waiting": "attempt",
	"attempt.succeeded": "attempt",
	"attempt.failed": "attempt",
	"attempt.timed_out": "attempt",
	"attempt.cancelled": "attempt",
	"attempt.interrupted": "attempt",
	"verification.started": "verification",
	"verification.passed": "verification",
	"verification.failed": "verification",
	"verification.skipped": "verification",
};

const WORKFLOW_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(EVENT_ENTITY_TYPES));

function violation(code: string, message: string): DomainViolation {
	return { code, message };
}

function validateRequiredText(value: string, code: string, fieldName: string): readonly DomainViolation[] {
	return value.trim().length === 0 ? [violation(code, `${fieldName} is required`)] : [];
}

function validateCreatedEntity(event: AnyWorkflowEvent): readonly DomainViolation[] {
	switch (event.eventType) {
		case "workflow.created":
			return event.entityId === event.workflowId &&
				event.payload.workflow.id === event.entityId &&
				event.payload.workflow.revision === event.entityRevision
				? validateWorkflow(event.payload.workflow)
				: [
						violation(
							"event.created_entity_mismatch",
							"Created workflow id and revision must match the event envelope",
						),
					];
		case "plan.created":
			return event.payload.plan.id === event.entityId &&
				event.payload.plan.workflowId === event.workflowId &&
				event.payload.plan.revision === event.entityRevision
				? validatePlan(event.payload.plan)
				: [
						violation(
							"event.created_entity_mismatch",
							"Created Plan id, workflow id, and revision must match the event envelope",
						),
					];
		case "task.created":
			return event.payload.task.id === event.entityId &&
				event.payload.task.workflowId === event.workflowId &&
				event.payload.task.revision === event.entityRevision
				? validateTask(event.payload.task)
				: [
						violation(
							"event.created_entity_mismatch",
							"Created task id, workflow id, and revision must match the event envelope",
						),
					];
		case "attempt.created":
			return event.payload.attempt.id === event.entityId &&
				event.payload.attempt.workflowId === event.workflowId &&
				event.payload.attempt.revision === event.entityRevision
				? validateAttempt(event.payload.attempt)
				: [
						violation(
							"event.created_entity_mismatch",
							"Created attempt id, workflow id, and revision must match the event envelope",
						),
					];
		case "verification.started":
			return event.payload.result.id === event.entityId && event.payload.result.workflowId === event.workflowId
				? []
				: [
						violation(
							"event.created_entity_mismatch",
							"Created verification id and workflow id must match the event envelope",
						),
					];
		default:
			return [];
	}
}

function validateStatusChange(event: AnyWorkflowEvent): readonly DomainViolation[] {
	switch (event.eventType) {
		case "workflow.status_changed":
			if (
				event.payload.fromStatus === "blocked" ||
				event.payload.toStatus === "blocked" ||
				event.payload.toStatus === "cancelling" ||
				event.payload.toStatus === "completed" ||
				event.payload.toStatus === "failed" ||
				event.payload.toStatus === "cancelled"
			) {
				return [
					violation(
						"event.specialized_event_required",
						"Blocked, cancellation, and terminal workflow changes require their specialized event type",
					),
				];
			}
			return validateWorkflowTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts);
		case "workflow.blocked":
			return event.payload.toStatus === "blocked"
				? validateWorkflowTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Workflow blocked event must target blocked")];
		case "workflow.unblocked":
			return event.payload.fromStatus === "blocked"
				? validateWorkflowTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.source_status_mismatch", "Workflow unblocked event must start from blocked")];
		case "workflow.cancel_requested":
			return event.payload.toStatus === "cancelling"
				? validateWorkflowTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Workflow cancel request must target cancelling")];
		case "workflow.completed":
			return event.payload.toStatus === "completed"
				? validateWorkflowTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Workflow completed event must target completed")];
		case "workflow.failed":
			return event.payload.toStatus === "failed"
				? validateWorkflowTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Workflow failed event must target failed")];
		case "workflow.cancelled":
			return event.payload.toStatus === "cancelled"
				? validateWorkflowTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Workflow cancelled event must target cancelled")];
		case "plan.awaiting_approval":
			return event.payload.toStatus === "awaiting_approval"
				? validatePlanTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Plan approval request must target awaiting_approval")];
		case "plan.approved":
			return event.payload.toStatus === "approved"
				? validatePlanTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Plan approved event must target approved")];
		case "plan.rejected":
			return event.payload.toStatus === "rejected"
				? validatePlanTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Plan rejected event must target rejected")];
		case "plan.superseded":
			return event.payload.toStatus === "superseded"
				? validatePlanTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Plan superseded event must target superseded")];
		case "task.ready":
			return event.payload.toStatus === "ready"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task ready event must target ready")];
		case "task.pending":
			return event.payload.toStatus === "pending"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task pending event must target pending")];
		case "task.started":
			return event.payload.toStatus === "running"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task started event must target running")];
		case "task.verification_started":
			return event.payload.toStatus === "verifying"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task verification event must target verifying")];
		case "task.blocked":
			return event.payload.toStatus === "blocked"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task blocked event must target blocked")];
		case "task.succeeded":
			return event.payload.toStatus === "succeeded"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task succeeded event must target succeeded")];
		case "task.failed":
			return event.payload.toStatus === "failed"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task failed event must target failed")];
		case "task.cancelled":
			return event.payload.toStatus === "cancelled"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task cancelled event must target cancelled")];
		case "task.skipped":
			return event.payload.toStatus === "skipped"
				? validateTaskTransition(event.payload.fromStatus, event.payload.toStatus, event.payload.facts)
				: [violation("event.target_status_mismatch", "Task skipped event must target skipped")];
		case "attempt.started":
			return event.payload.toStatus === "running"
				? validateAttemptTransition(event.payload.fromStatus, event.payload.toStatus)
				: [violation("event.target_status_mismatch", "Attempt started event must target running")];
		case "attempt.waiting":
			return event.payload.toStatus === "waiting"
				? validateAttemptTransition(event.payload.fromStatus, event.payload.toStatus)
				: [violation("event.target_status_mismatch", "Attempt waiting event must target waiting")];
		case "attempt.succeeded":
			return event.payload.toStatus === "succeeded"
				? validateAttemptTransition(event.payload.fromStatus, event.payload.toStatus)
				: [violation("event.target_status_mismatch", "Attempt succeeded event must target succeeded")];
		case "attempt.failed":
			return event.payload.toStatus === "failed"
				? validateAttemptTransition(event.payload.fromStatus, event.payload.toStatus)
				: [violation("event.target_status_mismatch", "Attempt failed event must target failed")];
		case "attempt.timed_out":
			return event.payload.toStatus === "timed_out"
				? validateAttemptTransition(event.payload.fromStatus, event.payload.toStatus)
				: [violation("event.target_status_mismatch", "Attempt timed out event must target timed_out")];
		case "attempt.cancelled":
			return event.payload.toStatus === "cancelled"
				? validateAttemptTransition(event.payload.fromStatus, event.payload.toStatus)
				: [violation("event.target_status_mismatch", "Attempt cancelled event must target cancelled")];
		case "attempt.interrupted":
			return event.payload.toStatus === "interrupted"
				? validateAttemptTransition(event.payload.fromStatus, event.payload.toStatus)
				: [violation("event.target_status_mismatch", "Attempt interrupted event must target interrupted")];
		default:
			return [];
	}
}

function validateTerminalPayload(event: AnyWorkflowEvent): readonly DomainViolation[] {
	switch (event.eventType) {
		case "workflow.completed":
			return event.payload.result.status === "completed"
				? []
				: [violation("event.result_status_mismatch", "Completed event requires a completed result")];
		case "workflow.failed":
			return event.payload.result.status === "failed"
				? []
				: [violation("event.result_status_mismatch", "Failed event requires a failed result")];
		case "workflow.cancelled":
			return event.payload.result.status === "cancelled"
				? []
				: [violation("event.result_status_mismatch", "Cancelled event requires a cancelled result")];
		case "verification.started":
			return event.payload.result.status === "running"
				? []
				: [violation("event.verification_status_mismatch", "Verification started event requires running status")];
		case "verification.passed":
			return event.payload.result.status === "passed"
				? []
				: [violation("event.verification_status_mismatch", "Verification passed event requires passed status")];
		case "verification.failed":
			return event.payload.result.status === "failed"
				? []
				: [violation("event.verification_status_mismatch", "Verification failed event requires failed status")];
		case "verification.skipped":
			return event.payload.result.status === "skipped"
				? []
				: [violation("event.verification_status_mismatch", "Verification skipped event requires skipped status")];
		default:
			return [];
	}
}

function validatePayloadFields(event: AnyWorkflowEvent): readonly DomainViolation[] {
	switch (event.eventType) {
		case "task.description_updated": {
			const error = validateContextHandoff(event.payload.description);
			return error ? [violation("event.invalid_task_description", error.message)] : [];
		}
		case "workflow.mode_decided": {
			const { decision } = event.payload;
			return (decision.mode === "direct" || decision.mode === "plan") &&
				["user", "forced_policy", "agent", "default"].includes(decision.source) &&
				["low", "medium", "high"].includes(decision.riskLevel) &&
				decision.reason.trim().length > 0 &&
				decision.decidedAt.length > 0
				? []
				: [violation("event.invalid_mode_decision", "Mode decision payload is invalid")];
		}
		case "workflow.plan_selected":
			return event.payload.planId.trim().length > 0
				? []
				: [violation("event.plan_id_required", "Workflow Plan selection requires a Plan id")];
		case "workflow.direct_plan_upgrade_requested": {
			const { request } = event.payload;
			return request.reason.trim().length > 0 &&
				["low", "medium", "high"].includes(request.riskLevel) &&
				request.triggers.length > 0 &&
				request.triggers.every((trigger) => ["complexity", "risk", "confidence"].includes(trigger)) &&
				Number.isFinite(Date.parse(request.requestedAt))
				? []
				: [violation("event.invalid_direct_plan_upgrade_request", "Direct Plan upgrade request is invalid")];
		}
		case "plan.approved":
		case "plan.rejected":
			if (event.actor.kind !== "user") {
				return [violation("event.user_actor_required", `${event.eventType} requires a user actor`)];
			}
			return event.payload.decision.action === (event.eventType === "plan.approved" ? "approved" : "rejected") &&
				event.payload.decision.comment.trim().length > 0 &&
				Number.isFinite(Date.parse(event.payload.decision.decidedAt))
				? []
				: [violation("event.invalid_plan_decision", `${event.eventType} requires a valid decision record`)];
		case "plan.superseded":
			return event.payload.replacementPlanId.trim().length > 0 &&
				event.payload.replacementPlanId !== event.entityId &&
				event.payload.decision.action === "revision_requested" &&
				event.payload.decision.comment.trim().length > 0 &&
				Number.isFinite(Date.parse(event.payload.decision.decidedAt))
				? []
				: [violation("event.replacement_plan_required", "Plan superseded event requires a replacement Plan")];
		case "workflow.cancel_requested":
		case "task.failed":
		case "task.cancelled":
		case "task.skipped":
			return event.payload.reason.trim().length > 0
				? []
				: [violation("event.reason_required", `${event.eventType} requires a reason`)];
		case "attempt.waiting":
			return event.payload.reason.trim().length > 0
				? []
				: [violation("event.reason_required", "Attempt waiting event requires a reason")];
		case "attempt.cancelled":
		case "attempt.interrupted":
			return event.payload.reason.trim().length > 0 && event.payload.endedAt.length > 0
				? []
				: [violation("event.invalid_attempt_end", `${event.eventType} requires a reason and end timestamp`)];
		case "task.dependency_added":
			return event.payload.dependencyId.trim().length > 0
				? []
				: [violation("event.dependency_id_required", "Task dependency event requires a dependency id")];
		case "task.modification_recorded": {
			const { modification } = event.payload;
			return modification.path.trim().length > 0 &&
				["edit", "write"].includes(modification.operation) &&
				modification.workflowId === event.workflowId &&
				modification.taskId === event.entityId &&
				modification.attemptId.trim().length > 0 &&
				modification.agentId.trim().length > 0 &&
				modification.toolCallId.trim().length > 0 &&
				Number.isFinite(Date.parse(modification.recordedAt))
				? []
				: [violation("event.invalid_modification", "Task modification record is invalid")];
		}
		case "task.operation_receipt_recorded": {
			const { receipt } = event.payload;
			return receipt.workflowId === event.workflowId &&
				receipt.taskId === event.entityId &&
				receipt.attemptId.trim().length > 0 &&
				receipt.toolCallId.trim().length > 0 &&
				receipt.toolName.trim().length > 0 &&
				["one_shot", "verification"].includes(receipt.kind) &&
				["succeeded", "failed"].includes(receipt.status) &&
				receipt.inputSummary.trim().length > 0 &&
				receipt.resultSummary.trim().length > 0 &&
				Number.isFinite(Date.parse(receipt.recordedAt))
				? []
				: [violation("event.invalid_operation_receipt", "Task operation receipt is invalid")];
		}
		case "task.started":
			return event.payload.attemptId.trim().length > 0
				? []
				: [violation("event.attempt_id_required", "Task started event requires an attempt id")];
		case "attempt.started":
			return event.payload.startedAt.length > 0
				? []
				: [violation("event.timestamp_required", "Attempt started event requires a timestamp")];
		case "attempt.succeeded":
		case "attempt.failed":
		case "attempt.timed_out":
			return event.payload.endedAt.length > 0
				? []
				: [violation("event.timestamp_required", `${event.eventType} requires an end timestamp`)];
		case "verification.started":
		case "verification.passed":
		case "verification.failed":
		case "verification.skipped":
			return event.payload.result.id.trim().length > 0 &&
				event.payload.result.workflowId === event.workflowId &&
				event.payload.result.requirementId.trim().length > 0
				? []
				: [violation("event.invalid_verification_result", "Verification result identity is invalid")];
		default:
			return [];
	}
}

export function isWorkflowEventType(value: unknown): value is WorkflowEventType {
	return typeof value === "string" && WORKFLOW_EVENT_TYPES.has(value);
}

export function createWorkflowEventBatch(input: CreateWorkflowEventBatchInput): WorkflowEventBatch {
	const events = input.events.map(
		(draft, index) =>
			({
				...draft,
				schemaVersion: WORKFLOW_SCHEMA_VERSION,
				workflowId: input.workflowId,
				sequence: input.expectedLastSequence + index + 1,
				entityType: EVENT_ENTITY_TYPES[draft.eventType],
				commandId: input.commandId,
				correlationId: input.correlationId,
			}) as AnyWorkflowEvent,
	);

	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		batchId: input.batchId,
		workflowId: input.workflowId,
		commandId: input.commandId,
		correlationId: input.correlationId,
		expectedLastSequence: input.expectedLastSequence,
		events,
	};
}

export function validateWorkflowEvent(event: AnyWorkflowEvent): readonly DomainViolation[] {
	const violations = [
		...validateRequiredText(event.eventId, "event.id_required", "Event id"),
		...validateRequiredText(event.workflowId, "event.workflow_id_required", "Workflow id"),
		...validateRequiredText(event.entityId, "event.entity_id_required", "Entity id"),
		...validateRequiredText(event.commandId, "event.command_id_required", "Command id"),
		...validateRequiredText(event.correlationId, "event.correlation_id_required", "Correlation id"),
		...validateRequiredText(event.occurredAt, "event.timestamp_required", "Event timestamp"),
	];

	if (event.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
		violations.push(
			violation("event.unsupported_schema", `Event schema version ${event.schemaVersion} is not supported`),
		);
	}
	if (!Number.isInteger(event.sequence) || event.sequence < 1) {
		violations.push(violation("event.invalid_sequence", "Event sequence must be a positive integer"));
	}
	if (!Number.isInteger(event.entityRevision) || event.entityRevision < 0) {
		violations.push(violation("event.invalid_revision", "Entity revision must be a non-negative integer"));
	}
	if (event.entityType !== EVENT_ENTITY_TYPES[event.eventType]) {
		violations.push(
			violation(
				"event.entity_type_mismatch",
				`${event.eventType} must target ${EVENT_ENTITY_TYPES[event.eventType]}`,
			),
		);
	}
	if (event.entityType === "workflow" && event.entityId !== event.workflowId) {
		violations.push(violation("event.workflow_entity_mismatch", "Workflow events must target their workflow id"));
	}
	if ((event.actor.kind === "agent" || event.actor.kind === "job") && !event.actor.id?.trim()) {
		violations.push(violation("event.actor_id_required", `${event.actor.kind} events require an actor id`));
	}
	if (event.causationId === event.eventId) {
		violations.push(violation("event.self_causation", "An event cannot cause itself"));
	}
	if (
		(event.eventType === "workflow.created" ||
			event.eventType === "plan.created" ||
			event.eventType === "task.created" ||
			event.eventType === "attempt.created" ||
			event.eventType === "verification.started") &&
		event.entityRevision !== 0
	) {
		violations.push(violation("event.invalid_creation_revision", "Created entities must start at revision zero"));
	}

	violations.push(
		...validateCreatedEntity(event),
		...validateStatusChange(event),
		...validateTerminalPayload(event),
		...validatePayloadFields(event),
	);
	return violations;
}

export function validateWorkflowEventBatch(batch: WorkflowEventBatch): readonly DomainViolation[] {
	const violations = [
		...validateRequiredText(batch.batchId, "batch.id_required", "Batch id"),
		...validateRequiredText(batch.workflowId, "batch.workflow_id_required", "Workflow id"),
		...validateRequiredText(batch.commandId, "batch.command_id_required", "Command id"),
		...validateRequiredText(batch.correlationId, "batch.correlation_id_required", "Correlation id"),
	];

	if (batch.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
		violations.push(
			violation("batch.unsupported_schema", `Batch schema version ${batch.schemaVersion} is not supported`),
		);
	}
	if (!Number.isInteger(batch.expectedLastSequence) || batch.expectedLastSequence < 0) {
		violations.push(
			violation("batch.invalid_expected_sequence", "Expected last sequence must be a non-negative integer"),
		);
	}
	if (batch.events.length === 0) {
		violations.push(violation("batch.events_required", "Event batch must contain at least one event"));
		return violations;
	}

	const allEventIds = new Set(batch.events.map((event) => event.eventId));
	const eventIds = new Set<string>();
	const entityRevisions = new Map<string, number>();
	for (const [index, event] of batch.events.entries()) {
		violations.push(...validateWorkflowEvent(event));

		const expectedSequence = batch.expectedLastSequence + index + 1;
		if (event.sequence !== expectedSequence) {
			violations.push(
				violation("batch.sequence_gap", `Event ${event.eventId} must use sequence ${expectedSequence}`),
			);
		}
		if (event.workflowId !== batch.workflowId) {
			violations.push(violation("batch.workflow_mismatch", `Event ${event.eventId} belongs to another workflow`));
		}
		if (event.commandId !== batch.commandId) {
			violations.push(violation("batch.command_mismatch", `Event ${event.eventId} belongs to another command`));
		}
		if (event.correlationId !== batch.correlationId) {
			violations.push(
				violation("batch.correlation_mismatch", `Event ${event.eventId} belongs to another correlation`),
			);
		}
		if (
			event.causationId &&
			event.causationId !== event.eventId &&
			allEventIds.has(event.causationId) &&
			!eventIds.has(event.causationId)
		) {
			violations.push(
				violation(
					"batch.causation_order",
					`Event ${event.eventId} cannot be caused by a later event in the same batch`,
				),
			);
		}
		if (eventIds.has(event.eventId)) {
			violations.push(violation("batch.duplicate_event", `Event id ${event.eventId} appears more than once`));
		}
		eventIds.add(event.eventId);

		const entityKey = `${event.entityType}:${event.entityId}`;
		const previousRevision = entityRevisions.get(entityKey);
		if (previousRevision !== undefined && event.entityRevision !== previousRevision + 1) {
			violations.push(
				violation(
					"batch.entity_revision_gap",
					`Entity ${entityKey} revision must increment from ${previousRevision} to ${previousRevision + 1}`,
				),
			);
		}
		entityRevisions.set(entityKey, event.entityRevision);
	}

	return violations;
}
