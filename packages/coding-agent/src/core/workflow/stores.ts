import type { PersistedWorkflowEventBatch } from "./event-log.ts";
import { isPersistedWorkflowEventBatch } from "./event-log.ts";
import type { AnyWorkflowEvent } from "./events.ts";
import { validateWorkflowEventBatch } from "./events.ts";
import { validateAttempt, validatePlan, validateTask, validateWorkflow } from "./invariants.ts";
import { validateTaskGraph } from "./task-graph.ts";
import type { DomainViolation } from "./transitions.ts";
import { validateRevisionTransition } from "./transitions.ts";
import type {
	Attempt,
	AttemptId,
	CommandId,
	Plan,
	PlanId,
	Task,
	TaskId,
	VerificationId,
	VerificationResult,
	Workflow,
	WorkflowId,
} from "./types.ts";
import { WORKFLOW_SCHEMA_VERSION } from "./types.ts";

export interface VerificationProjection {
	readonly revision: number;
	readonly result: VerificationResult;
}

export interface WorkflowSnapshot {
	readonly schemaVersion: number;
	readonly workflowId: WorkflowId;
	readonly lastSequence: number;
	readonly workflow: Workflow;
	readonly plans: readonly Plan[];
	readonly tasks: readonly Task[];
	readonly attempts: readonly Attempt[];
	readonly verifications: readonly VerificationProjection[];
	readonly processedCommands: readonly { readonly commandId: CommandId; readonly batchId: string }[];
	readonly eventIds: readonly string[];
	readonly createdAt: string;
}

interface MutableStoreState {
	readonly workflows: Map<WorkflowId, Workflow>;
	readonly plans: Map<PlanId, Plan>;
	readonly tasks: Map<TaskId, Task>;
	readonly attempts: Map<AttemptId, Attempt>;
	readonly verifications: Map<VerificationId, VerificationProjection>;
}

export class WorkflowStoreError extends Error {
	readonly violations: readonly DomainViolation[];

	constructor(message: string, violations: readonly DomainViolation[]) {
		super(message);
		this.name = "WorkflowStoreError";
		this.violations = violations;
	}
}

function violation(code: string, message: string): DomainViolation {
	return { code, message };
}

function fail(code: string, message: string): never {
	throw new WorkflowStoreError(message, [violation(code, message)]);
}

function assertValidEntity(entityName: string, violations: readonly DomainViolation[]): void {
	if (violations.length > 0) {
		throw new WorkflowStoreError(`Invalid ${entityName} projection`, violations);
	}
}

function assertRevision(event: AnyWorkflowEvent, currentRevision: number): void {
	const violations = validateRevisionTransition(currentRevision, event.entityRevision);
	if (violations.length > 0) {
		throw new WorkflowStoreError(`Revision conflict for ${event.entityType} ${event.entityId}`, violations);
	}
}

function assertStatus(currentStatus: string, eventStatus: string, event: AnyWorkflowEvent): void {
	if (currentStatus !== eventStatus) {
		fail(
			"store.status_conflict",
			`${event.entityType} ${event.entityId} is ${currentStatus}, event expects ${eventStatus}`,
		);
	}
}

function getWorkflow(state: MutableStoreState, event: AnyWorkflowEvent): Workflow {
	const workflow = state.workflows.get(event.workflowId);
	if (!workflow) {
		fail("store.workflow_missing", `Workflow ${event.workflowId} does not exist`);
	}
	return workflow;
}

function getTask(state: MutableStoreState, event: AnyWorkflowEvent): Task {
	const task = state.tasks.get(event.entityId);
	if (!task) {
		fail("store.task_missing", `Task ${event.entityId} does not exist`);
	}
	if (task.workflowId !== event.workflowId) {
		fail("store.task_workflow_mismatch", `Task ${event.entityId} belongs to another workflow`);
	}
	return task;
}

function getPlan(state: MutableStoreState, event: AnyWorkflowEvent): Plan {
	const plan = state.plans.get(event.entityId);
	if (!plan) {
		fail("store.plan_missing", `Plan ${event.entityId} does not exist`);
	}
	if (plan.workflowId !== event.workflowId) {
		fail("store.plan_workflow_mismatch", `Plan ${event.entityId} belongs to another workflow`);
	}
	return plan;
}

function getAttempt(state: MutableStoreState, event: AnyWorkflowEvent): Attempt {
	const attempt = state.attempts.get(event.entityId);
	if (!attempt) {
		fail("store.attempt_missing", `Attempt ${event.entityId} does not exist`);
	}
	if (attempt.workflowId !== event.workflowId) {
		fail("store.attempt_workflow_mismatch", `Attempt ${event.entityId} belongs to another workflow`);
	}
	return attempt;
}

function applyWorkflowEvent(state: MutableStoreState, event: AnyWorkflowEvent): boolean {
	switch (event.eventType) {
		case "workflow.created": {
			if (state.workflows.has(event.entityId)) {
				fail("store.workflow_exists", `Workflow ${event.entityId} already exists`);
			}
			const workflow = structuredClone(event.payload.workflow);
			assertValidEntity("workflow", validateWorkflow(workflow));
			state.workflows.set(workflow.id, workflow);
			return true;
		}
		case "workflow.mode_decided": {
			const current = getWorkflow(state, event);
			assertRevision(event, current.revision);
			const workflow: Workflow = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				modeDecision: structuredClone(event.payload.decision),
			};
			assertValidEntity("workflow", validateWorkflow(workflow));
			state.workflows.set(workflow.id, workflow);
			return true;
		}
		case "workflow.direct_plan_upgrade_requested": {
			const current = getWorkflow(state, event);
			assertRevision(event, current.revision);
			if (current.directPlanUpgradeRequest) {
				fail(
					"store.direct_plan_upgrade_exists",
					`Workflow ${current.id} already has a Direct Plan upgrade request`,
				);
			}
			const workflow: Workflow = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				directPlanUpgradeRequest: structuredClone(event.payload.request),
			};
			assertValidEntity("workflow", validateWorkflow(workflow));
			state.workflows.set(workflow.id, workflow);
			return true;
		}
		case "workflow.plan_selected": {
			const current = getWorkflow(state, event);
			assertRevision(event, current.revision);
			const plan = state.plans.get(event.payload.planId);
			if (!plan || plan.workflowId !== current.id) {
				fail("store.plan_missing", `Plan ${event.payload.planId} does not exist in workflow ${current.id}`);
			}
			if (plan.status !== "draft" && plan.status !== "awaiting_approval") {
				fail("store.plan_not_selectable", `Plan ${plan.id} cannot be selected while ${plan.status}`);
			}
			const workflow: Workflow = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				currentPlanId: plan.id,
			};
			assertValidEntity("workflow", validateWorkflow(workflow));
			state.workflows.set(workflow.id, workflow);
			return true;
		}
		case "workflow.status_changed":
		case "workflow.unblocked": {
			const current = getWorkflow(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const workflow: Workflow = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				blockedReason: undefined,
			};
			assertValidEntity("workflow", validateWorkflow(workflow));
			state.workflows.set(workflow.id, workflow);
			return true;
		}
		case "workflow.blocked": {
			const current = getWorkflow(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const workflow: Workflow = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				blockedReason: structuredClone(event.payload.reason),
			};
			assertValidEntity("workflow", validateWorkflow(workflow));
			state.workflows.set(workflow.id, workflow);
			return true;
		}
		case "workflow.cancel_requested": {
			const current = getWorkflow(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const workflow: Workflow = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				blockedReason: undefined,
			};
			assertValidEntity("workflow", validateWorkflow(workflow));
			state.workflows.set(workflow.id, workflow);
			return true;
		}
		case "workflow.completed":
		case "workflow.failed":
		case "workflow.cancelled": {
			const current = getWorkflow(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const workflow: Workflow = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				blockedReason: undefined,
				result: structuredClone(event.payload.result),
			};
			assertValidEntity("workflow", validateWorkflow(workflow));
			state.workflows.set(workflow.id, workflow);
			return true;
		}
		default:
			return false;
	}
}

function applyPlanEvent(state: MutableStoreState, event: AnyWorkflowEvent): boolean {
	switch (event.eventType) {
		case "plan.created": {
			if (state.plans.has(event.entityId)) {
				fail("store.plan_exists", `Plan ${event.entityId} already exists`);
			}
			getWorkflow(state, event);
			const plan = structuredClone(event.payload.plan);
			for (const existing of state.plans.values()) {
				if (existing.workflowId === plan.workflowId && existing.version === plan.version) {
					fail(
						"store.plan_version_exists",
						`Workflow ${plan.workflowId} already has Plan version ${plan.version}`,
					);
				}
			}
			if (plan.supersedesPlanId) {
				const previous = state.plans.get(plan.supersedesPlanId);
				if (!previous || previous.workflowId !== plan.workflowId || plan.version !== previous.version + 1) {
					fail("store.invalid_plan_predecessor", `Plan ${plan.id} does not reference the preceding Plan version`);
				}
			} else if (plan.version !== 1) {
				fail("store.invalid_plan_version", "The first Plan in a workflow must use version 1");
			}
			assertValidEntity("plan", validatePlan(plan));
			state.plans.set(plan.id, plan);
			return true;
		}
		case "plan.content_updated": {
			const current = getPlan(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, "draft", event);
			const plan: Plan = {
				...current,
				...structuredClone(event.payload.content),
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
			};
			assertValidEntity("plan", validatePlan(plan));
			state.plans.set(plan.id, plan);
			return true;
		}
		case "plan.awaiting_approval":
		case "plan.approved":
		case "plan.rejected":
		case "plan.superseded": {
			const current = getPlan(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const workflow = getWorkflow(state, event);
			if (workflow.currentPlanId !== current.id) {
				fail("store.plan_not_current", `Plan ${current.id} is not the current Plan for workflow ${workflow.id}`);
			}
			if (
				event.eventType === "plan.awaiting_approval" &&
				[...state.plans.values()].some(
					(plan) => plan.workflowId === current.workflowId && plan.version > current.version,
				)
			) {
				fail("store.plan_not_latest", `Plan ${current.id} is not the latest Plan version`);
			}
			if (event.eventType === "plan.superseded") {
				const replacement = state.plans.get(event.payload.replacementPlanId);
				if (
					!replacement ||
					replacement.workflowId !== current.workflowId ||
					replacement.supersedesPlanId !== current.id ||
					replacement.version !== current.version + 1
				) {
					fail(
						"store.invalid_replacement_plan",
						`Plan ${event.payload.replacementPlanId} is not a valid replacement for ${current.id}`,
					);
				}
			}
			const plan: Plan = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				decisionHistory:
					event.eventType === "plan.awaiting_approval"
						? current.decisionHistory
						: [...current.decisionHistory, structuredClone(event.payload.decision)],
			};
			assertValidEntity("plan", validatePlan(plan));
			state.plans.set(plan.id, plan);
			return true;
		}
		default:
			return false;
	}
}

function applyTaskEvent(state: MutableStoreState, event: AnyWorkflowEvent): boolean {
	switch (event.eventType) {
		case "task.description_updated": {
			const current = getTask(state, event);
			const workflow = getWorkflow(state, event);
			assertRevision(event, current.revision);
			if (
				workflow.modeDecision?.mode !== "direct" ||
				workflow.status !== "executing" ||
				current.status !== "running" ||
				workflow.rootTaskId !== current.id
			) {
				fail("store.handoff_not_running", "Task handoff requires a running Direct root Task");
			}
			state.tasks.set(current.id, {
				...current,
				description: event.payload.description,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
			});
			return true;
		}
		case "task.created": {
			if (state.tasks.has(event.entityId)) {
				fail("store.task_exists", `Task ${event.entityId} already exists`);
			}
			getWorkflow(state, event);
			const task = structuredClone(event.payload.task);
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.dependency_added": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			const dependency = state.tasks.get(event.payload.dependencyId);
			if (!dependency || dependency.workflowId !== current.workflowId) {
				fail(
					"store.dependency_missing",
					`Dependency ${event.payload.dependencyId} does not exist in this workflow`,
				);
			}
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				dependencyIds: [...current.dependencyIds, event.payload.dependencyId],
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.assigned": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				assignment: structuredClone(event.payload.assignment),
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.modification_recorded": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			const modification = structuredClone(event.payload.modification);
			if (
				modification.workflowId !== current.workflowId ||
				modification.taskId !== current.id ||
				!current.attemptIds.includes(modification.attemptId)
			) {
				fail("store.modification_owner_mismatch", "File modification does not belong to the target Task");
			}
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				modifications: [...current.modifications, modification],
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.pending":
		case "task.ready": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				blockedReason: undefined,
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.started": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const attempt = state.attempts.get(event.payload.attemptId);
			if (!attempt || attempt.taskId !== current.id || attempt.workflowId !== current.workflowId) {
				fail(
					"store.attempt_task_mismatch",
					`Attempt ${event.payload.attemptId} does not belong to task ${current.id}`,
				);
			}
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				attemptIds: current.attemptIds.includes(attempt.id)
					? current.attemptIds
					: [...current.attemptIds, attempt.id],
				currentAttemptId: attempt.id,
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.verification_started": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.blocked": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				blockedReason: structuredClone(event.payload.reason),
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.succeeded": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				blockedReason: undefined,
				result: structuredClone(event.payload.result),
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		case "task.failed":
		case "task.cancelled":
		case "task.skipped": {
			const current = getTask(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const task: Task = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				blockedReason: undefined,
			};
			assertValidEntity("task", validateTask(task));
			state.tasks.set(task.id, task);
			return true;
		}
		default:
			return false;
	}
}

function applyAttemptEvent(state: MutableStoreState, event: AnyWorkflowEvent): boolean {
	switch (event.eventType) {
		case "attempt.created": {
			if (state.attempts.has(event.entityId)) {
				fail("store.attempt_exists", `Attempt ${event.entityId} already exists`);
			}
			const task = state.tasks.get(event.payload.attempt.taskId);
			if (!task || task.workflowId !== event.workflowId) {
				fail("store.attempt_task_missing", `Task ${event.payload.attempt.taskId} does not exist for this attempt`);
			}
			for (const attempt of state.attempts.values()) {
				if (attempt.taskId === task.id && attempt.number === event.payload.attempt.number) {
					fail(
						"store.attempt_number_conflict",
						`Task ${task.id} already has attempt number ${event.payload.attempt.number}`,
					);
				}
			}
			const attempt = structuredClone(event.payload.attempt);
			assertValidEntity("attempt", validateAttempt(attempt));
			state.attempts.set(attempt.id, attempt);
			return true;
		}
		case "attempt.started":
		case "attempt.waiting": {
			const current = getAttempt(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const attempt: Attempt = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				startedAt: event.eventType === "attempt.started" ? event.payload.startedAt : current.startedAt,
			};
			assertValidEntity("attempt", validateAttempt(attempt));
			state.attempts.set(attempt.id, attempt);
			return true;
		}
		case "attempt.succeeded":
		case "attempt.timed_out":
		case "attempt.cancelled":
		case "attempt.interrupted": {
			const current = getAttempt(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const attempt: Attempt = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				endedAt: event.payload.endedAt,
				usage: structuredClone(event.payload.usage),
			};
			assertValidEntity("attempt", validateAttempt(attempt));
			state.attempts.set(attempt.id, attempt);
			return true;
		}
		case "attempt.failed": {
			const current = getAttempt(state, event);
			assertRevision(event, current.revision);
			assertStatus(current.status, event.payload.fromStatus, event);
			const attempt: Attempt = {
				...current,
				revision: event.entityRevision,
				updatedAt: event.occurredAt,
				status: event.payload.toStatus,
				endedAt: event.payload.endedAt,
				usage: structuredClone(event.payload.usage),
				failure: structuredClone(event.payload.failure),
			};
			assertValidEntity("attempt", validateAttempt(attempt));
			state.attempts.set(attempt.id, attempt);
			return true;
		}
		default:
			return false;
	}
}

function validateVerificationResult(result: VerificationResult): readonly DomainViolation[] {
	const violations: DomainViolation[] = [];
	if (!result.id || !result.workflowId || !result.requirementId) {
		violations.push(
			violation("verification.owner_required", "Verification id, workflow, and requirement are required"),
		);
	}
	if (result.status === "running" && !result.startedAt) {
		violations.push(violation("verification.start_required", "Running verification requires a start time"));
	}
	if ((result.status === "passed" || result.status === "failed" || result.status === "skipped") && !result.endedAt) {
		violations.push(violation("verification.end_required", `Verification ${result.status} requires an end time`));
	}
	if (result.status === "skipped" && !result.skipReason?.trim()) {
		violations.push(violation("verification.skip_reason_required", "Skipped verification requires a reason"));
	}
	return violations;
}

function applyVerificationEvent(state: MutableStoreState, event: AnyWorkflowEvent): boolean {
	switch (event.eventType) {
		case "verification.started": {
			if (state.verifications.has(event.entityId)) {
				fail("store.verification_exists", `Verification ${event.entityId} already exists`);
			}
			if (event.entityRevision !== 0) {
				fail("store.verification_revision", "New verification must start at revision zero");
			}
			const result = structuredClone(event.payload.result);
			if (
				result.id !== event.entityId ||
				result.workflowId !== event.workflowId ||
				(result.taskId !== undefined && !state.tasks.has(result.taskId))
			) {
				fail("store.verification_owner_mismatch", "Verification owner does not match the event envelope");
			}
			assertValidEntity("verification", validateVerificationResult(result));
			state.verifications.set(result.id, { revision: event.entityRevision, result });
			return true;
		}
		case "verification.passed":
		case "verification.failed":
		case "verification.skipped": {
			const current = state.verifications.get(event.entityId);
			if (!current) {
				fail("store.verification_missing", `Verification ${event.entityId} does not exist`);
			}
			assertRevision(event, current.revision);
			const result = structuredClone(event.payload.result);
			if (
				result.id !== event.entityId ||
				result.workflowId !== event.workflowId ||
				result.taskId !== current.result.taskId ||
				result.requirementId !== current.result.requirementId
			) {
				fail("store.verification_owner_mismatch", "Verification identity cannot change");
			}
			assertValidEntity("verification", validateVerificationResult(result));
			state.verifications.set(result.id, { revision: event.entityRevision, result });
			return true;
		}
		default:
			return false;
	}
}

function applyEvent(state: MutableStoreState, event: AnyWorkflowEvent): void {
	if (
		applyWorkflowEvent(state, event) ||
		applyPlanEvent(state, event) ||
		applyTaskEvent(state, event) ||
		applyAttemptEvent(state, event) ||
		applyVerificationEvent(state, event)
	) {
		return;
	}
	fail("store.unsupported_event", `Event ${event.eventType} is not supported by WorkflowStore`);
}

function validateRelationships(state: MutableStoreState): readonly DomainViolation[] {
	const violations: DomainViolation[] = [];
	for (const workflow of state.workflows.values()) {
		if (workflow.rootTaskId) {
			const rootTask = state.tasks.get(workflow.rootTaskId);
			if (!rootTask || rootTask.workflowId !== workflow.id || rootTask.parentTaskId) {
				violations.push(
					violation("store.invalid_root_task", `Workflow ${workflow.id} does not reference a valid root task`),
				);
			}
		}
		if (workflow.currentPlanId) {
			const plan = state.plans.get(workflow.currentPlanId);
			if (!plan || plan.workflowId !== workflow.id || plan.status === "superseded") {
				violations.push(
					violation("store.invalid_current_plan", `Workflow ${workflow.id} does not reference a current Plan`),
				);
			}
		}
		violations.push(
			...validateTaskGraph([...state.tasks.values()].filter((task) => task.workflowId === workflow.id)),
		);
	}
	for (const plan of state.plans.values()) {
		if (!state.workflows.has(plan.workflowId)) {
			violations.push(
				violation("store.invalid_plan_workflow", `Plan ${plan.id} does not reference an existing workflow`),
			);
		}
		if (plan.supersedesPlanId) {
			const previous = state.plans.get(plan.supersedesPlanId);
			if (!previous || previous.workflowId !== plan.workflowId || previous.version + 1 !== plan.version) {
				violations.push(violation("store.invalid_plan_predecessor", `Plan ${plan.id} has an invalid predecessor`));
			}
		}
	}
	for (const task of state.tasks.values()) {
		if (task.parentTaskId) {
			const parent = state.tasks.get(task.parentTaskId);
			if (!parent || parent.workflowId !== task.workflowId) {
				violations.push(
					violation("store.invalid_parent_task", `Task ${task.id} does not reference a valid parent task`),
				);
			}
		}
		for (const dependencyId of task.dependencyIds) {
			const dependency = state.tasks.get(dependencyId);
			if (!dependency || dependency.workflowId !== task.workflowId) {
				violations.push(
					violation("store.invalid_dependency", `Task ${task.id} has invalid dependency ${dependencyId}`),
				);
			}
		}
	}
	return violations;
}

function cloneState(state: MutableStoreState): MutableStoreState {
	return {
		workflows: new Map(state.workflows),
		plans: new Map(state.plans),
		tasks: new Map(state.tasks),
		attempts: new Map(state.attempts),
		verifications: new Map(state.verifications),
	};
}

export class WorkflowStore {
	#state: MutableStoreState = {
		workflows: new Map(),
		plans: new Map(),
		tasks: new Map(),
		attempts: new Map(),
		verifications: new Map(),
	};
	readonly #lastSequences = new Map<WorkflowId, number>();
	readonly #processedCommands = new Map<string, string>();
	readonly #eventIds = new Set<string>();
	readonly #eventWorkflowIds = new Map<string, WorkflowId>();

	apply(persisted: PersistedWorkflowEventBatch): boolean {
		if (!isPersistedWorkflowEventBatch(persisted)) {
			fail("store.unpersisted_batch", "WorkflowStore only accepts batches returned by the Event Log");
		}
		const { batch } = persisted;
		const batchViolations = validateWorkflowEventBatch(batch);
		if (batchViolations.length > 0) {
			throw new WorkflowStoreError("Cannot apply an invalid event batch", batchViolations);
		}

		const commandKey = `${batch.workflowId}:${batch.commandId}`;
		if (this.#processedCommands.has(commandKey)) {
			return false;
		}
		const currentLastSequence = this.#lastSequences.get(batch.workflowId) ?? 0;
		if (batch.expectedLastSequence !== currentLastSequence) {
			fail(
				"store.sequence_conflict",
				`Workflow ${batch.workflowId} expected sequence ${batch.expectedLastSequence}, current is ${currentLastSequence}`,
			);
		}
		for (const event of batch.events) {
			if (this.#eventIds.has(event.eventId)) {
				fail("store.duplicate_event", `Event ${event.eventId} has already been applied`);
			}
		}

		const nextState = cloneState(this.#state);
		try {
			for (const event of batch.events) {
				applyEvent(nextState, event);
			}
			const relationshipViolations = validateRelationships(nextState);
			if (relationshipViolations.length > 0) {
				throw new WorkflowStoreError("Workflow relationships are invalid", relationshipViolations);
			}
		} catch (error) {
			if (error instanceof WorkflowStoreError) {
				throw error;
			}
			throw new WorkflowStoreError("Failed to apply workflow event payload", [
				violation("store.invalid_event_payload", error instanceof Error ? error.message : String(error)),
			]);
		}

		this.#state = nextState;
		this.#processedCommands.set(commandKey, batch.batchId);
		for (const event of batch.events) {
			this.#eventIds.add(event.eventId);
			this.#eventWorkflowIds.set(event.eventId, batch.workflowId);
		}
		const lastEvent = batch.events.at(-1);
		if (lastEvent) {
			this.#lastSequences.set(batch.workflowId, lastEvent.sequence);
		}
		return true;
	}

	replay(batches: readonly PersistedWorkflowEventBatch[]): void {
		for (const batch of batches) {
			this.apply(batch);
		}
	}

	createSnapshot(workflowId: WorkflowId, createdAt = new Date().toISOString()): WorkflowSnapshot {
		const workflow = this.getWorkflow(workflowId);
		if (!workflow) {
			fail("store.workflow_missing", `Workflow ${workflowId} does not exist`);
		}
		const taskIds = new Set(this.listTasks(workflowId).map(({ id }) => id));
		return {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			workflowId,
			lastSequence: this.getLastSequence(workflowId),
			workflow,
			plans: this.listPlans(workflowId),
			tasks: this.listTasks(workflowId),
			attempts: [...this.#state.attempts.values()]
				.filter(({ taskId }) => taskIds.has(taskId))
				.map((attempt) => structuredClone(attempt)),
			verifications: [...this.#state.verifications.values()]
				.filter(({ result }) => result.workflowId === workflowId)
				.map((verification) => structuredClone(verification)),
			processedCommands: [...this.#processedCommands.entries()]
				.filter(([key]) => key.startsWith(`${workflowId}:`))
				.map(([key, batchId]) => ({ commandId: key.slice(workflowId.length + 1), batchId })),
			eventIds: [...this.#eventWorkflowIds.entries()]
				.filter(([, eventWorkflowId]) => eventWorkflowId === workflowId)
				.map(([eventId]) => eventId),
			createdAt,
		};
	}

	restoreSnapshot(snapshot: WorkflowSnapshot): void {
		if (
			snapshot.schemaVersion !== WORKFLOW_SCHEMA_VERSION ||
			snapshot.workflow.id !== snapshot.workflowId ||
			!Number.isInteger(snapshot.lastSequence) ||
			snapshot.lastSequence < 0 ||
			!Number.isFinite(Date.parse(snapshot.createdAt))
		) {
			fail("store.invalid_snapshot", "Workflow Snapshot envelope is invalid");
		}
		if (this.#state.workflows.has(snapshot.workflowId)) {
			fail("store.snapshot_workflow_exists", `Workflow ${snapshot.workflowId} already exists`);
		}
		if (
			new Set(snapshot.plans.map(({ id }) => id)).size !== snapshot.plans.length ||
			new Set(snapshot.tasks.map(({ id }) => id)).size !== snapshot.tasks.length ||
			new Set(snapshot.attempts.map(({ id }) => id)).size !== snapshot.attempts.length ||
			new Set(snapshot.verifications.map(({ result }) => result.id)).size !== snapshot.verifications.length
		) {
			fail("store.snapshot_duplicate_entity", "Workflow Snapshot contains duplicate entity ids");
		}
		if (
			snapshot.eventIds.length !== snapshot.lastSequence ||
			new Set(snapshot.eventIds).size !== snapshot.eventIds.length ||
			snapshot.eventIds.some((eventId) => !eventId.trim())
		) {
			fail("store.snapshot_event_history_invalid", "Workflow Snapshot event history is invalid");
		}
		if (
			new Set(snapshot.processedCommands.map(({ commandId }) => commandId)).size !==
				snapshot.processedCommands.length ||
			snapshot.processedCommands.some(({ commandId, batchId }) => !commandId.trim() || !batchId.trim())
		) {
			fail("store.snapshot_command_history_invalid", "Workflow Snapshot command history is invalid");
		}
		assertValidEntity("workflow", validateWorkflow(snapshot.workflow));
		for (const plan of snapshot.plans) {
			if (plan.workflowId !== snapshot.workflowId) {
				fail("store.snapshot_owner_mismatch", `Plan ${plan.id} belongs to another Workflow`);
			}
			assertValidEntity("plan", validatePlan(plan));
		}
		for (const task of snapshot.tasks) {
			if (task.workflowId !== snapshot.workflowId) {
				fail("store.snapshot_owner_mismatch", `Task ${task.id} belongs to another Workflow`);
			}
			assertValidEntity("task", validateTask(task));
		}
		for (const attempt of snapshot.attempts) {
			if (attempt.workflowId !== snapshot.workflowId) {
				fail("store.snapshot_owner_mismatch", `Attempt ${attempt.id} belongs to another Workflow`);
			}
			if (!snapshot.tasks.some(({ id }) => id === attempt.taskId)) {
				fail("store.snapshot_attempt_task_missing", `Attempt ${attempt.id} references a missing Task`);
			}
			assertValidEntity("attempt", validateAttempt(attempt));
		}
		for (const verification of snapshot.verifications) {
			if (verification.result.workflowId !== snapshot.workflowId) {
				fail("store.snapshot_owner_mismatch", `Verification ${verification.result.id} belongs to another Workflow`);
			}
			if (
				!Number.isInteger(verification.revision) ||
				verification.revision < 0 ||
				(verification.result.taskId !== undefined &&
					!snapshot.tasks.some(({ id }) => id === verification.result.taskId))
			) {
				fail(
					"store.snapshot_verification_projection_invalid",
					`Verification ${verification.result.id} projection is invalid`,
				);
			}
			assertValidEntity("verification", validateVerificationResult(verification.result));
		}
		const nextState = cloneState(this.#state);
		nextState.workflows.set(snapshot.workflow.id, structuredClone(snapshot.workflow));
		for (const plan of snapshot.plans) {
			nextState.plans.set(plan.id, structuredClone(plan));
		}
		for (const task of snapshot.tasks) {
			nextState.tasks.set(task.id, structuredClone(task));
		}
		for (const attempt of snapshot.attempts) {
			nextState.attempts.set(attempt.id, structuredClone(attempt));
		}
		for (const verification of snapshot.verifications) {
			nextState.verifications.set(verification.result.id, structuredClone(verification));
		}
		const violations = validateRelationships(nextState);
		if (violations.length > 0) {
			throw new WorkflowStoreError("Workflow Snapshot relationships are invalid", violations);
		}
		this.#state = nextState;
		this.#lastSequences.set(snapshot.workflowId, snapshot.lastSequence);
		for (const { commandId, batchId } of snapshot.processedCommands) {
			this.#processedCommands.set(`${snapshot.workflowId}:${commandId}`, batchId);
		}
		for (const eventId of snapshot.eventIds) {
			this.#eventIds.add(eventId);
			this.#eventWorkflowIds.set(eventId, snapshot.workflowId);
		}
	}

	getWorkflow(workflowId: WorkflowId): Workflow | undefined {
		const workflow = this.#state.workflows.get(workflowId);
		return workflow ? structuredClone(workflow) : undefined;
	}

	listWorkflows(): readonly Workflow[] {
		return [...this.#state.workflows.values()].map((workflow) => structuredClone(workflow));
	}

	getPlan(planId: PlanId): Plan | undefined {
		const plan = this.#state.plans.get(planId);
		return plan ? structuredClone(plan) : undefined;
	}

	listPlans(workflowId: WorkflowId): readonly Plan[] {
		return [...this.#state.plans.values()]
			.filter((plan) => plan.workflowId === workflowId)
			.sort((left, right) => left.version - right.version)
			.map((plan) => structuredClone(plan));
	}

	getTask(taskId: TaskId): Task | undefined {
		const task = this.#state.tasks.get(taskId);
		return task ? structuredClone(task) : undefined;
	}

	listTasks(workflowId: WorkflowId): readonly Task[] {
		return [...this.#state.tasks.values()]
			.filter((task) => task.workflowId === workflowId)
			.map((task) => structuredClone(task));
	}

	getAttempt(attemptId: AttemptId): Attempt | undefined {
		const attempt = this.#state.attempts.get(attemptId);
		return attempt ? structuredClone(attempt) : undefined;
	}

	listAttempts(taskId: TaskId): readonly Attempt[] {
		return [...this.#state.attempts.values()]
			.filter((attempt) => attempt.taskId === taskId)
			.sort((left, right) => left.number - right.number)
			.map((attempt) => structuredClone(attempt));
	}

	getVerification(verificationId: VerificationId): VerificationResult | undefined {
		const verification = this.#state.verifications.get(verificationId);
		return verification ? structuredClone(verification.result) : undefined;
	}

	getVerificationRevision(verificationId: VerificationId): number | undefined {
		return this.#state.verifications.get(verificationId)?.revision;
	}

	listVerifications(workflowId: WorkflowId): readonly VerificationResult[] {
		return [...this.#state.verifications.values()]
			.filter(({ result }) => result.workflowId === workflowId)
			.map(({ result }) => structuredClone(result));
	}

	getLastSequence(workflowId: WorkflowId): number {
		return this.#lastSequences.get(workflowId) ?? 0;
	}

	hasProcessedCommand(workflowId: WorkflowId, commandId: CommandId): boolean {
		return this.#processedCommands.has(`${workflowId}:${commandId}`);
	}
}
