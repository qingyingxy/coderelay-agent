import type { AttemptStatus, TaskStatus, WorkflowBlockedResumeStatus, WorkflowStatus } from "./types.ts";

export interface DomainViolation {
	readonly code: string;
	readonly message: string;
}

export interface WorkflowTransitionFacts {
	readonly clarificationRequired?: boolean;
	readonly clarificationComplete?: boolean;
	readonly rootTaskExists?: boolean;
	readonly directModeSelected?: boolean;
	readonly planModeSelected?: boolean;
	readonly planReady?: boolean;
	readonly planReadOnly?: boolean;
	readonly planApproved?: boolean;
	readonly taskGraphReady?: boolean;
	readonly replacementPlanCreated?: boolean;
	readonly replanningRequested?: boolean;
	readonly allRequiredTasksSucceeded?: boolean;
	readonly completionGatePassed?: boolean;
	readonly repairTaskCreated?: boolean;
	readonly blockedReasonPresent?: boolean;
	readonly blockResolved?: boolean;
	readonly blockedResumeStatus?: WorkflowBlockedResumeStatus;
	readonly writeOperationsStopped?: boolean;
	readonly cancellationRequested?: boolean;
	readonly failureTerminalCondition?: boolean;
	readonly runtimeResourcesStopped?: boolean;
	readonly writerLeaseReleased?: boolean;
}

export interface TaskTransitionFacts {
	readonly workflowExecuting?: boolean;
	readonly dependenciesSucceeded?: boolean;
	readonly attemptCreated?: boolean;
	readonly attemptSucceeded?: boolean;
	readonly hasRequiredVerification?: boolean;
	readonly requiredVerificationPassed?: boolean;
	readonly taskResultPresent?: boolean;
	readonly retryAllowed?: boolean;
	readonly blockedReasonPresent?: boolean;
	readonly blockResolved?: boolean;
	readonly activeAttemptStopped?: boolean;
	readonly failureTerminalCondition?: boolean;
	readonly writerLeaseRequired?: boolean;
	readonly writerLeaseHeld?: boolean;
	readonly controlTask?: boolean;
	readonly taskNoLongerRequired?: boolean;
}

const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
	received: ["clarifying", "planning", "executing", "cancelling"],
	clarifying: ["planning", "executing", "cancelling"],
	planning: ["awaiting_approval", "blocked", "cancelling"],
	awaiting_approval: ["planning", "executing", "cancelling"],
	executing: ["planning", "verifying", "blocked", "cancelling", "failed"],
	verifying: ["completed", "executing", "blocked", "cancelling", "failed"],
	blocked: ["planning", "executing", "verifying", "cancelling", "failed"],
	cancelling: ["cancelled"],
	completed: [],
	failed: [],
	cancelled: [],
};

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	pending: ["ready", "blocked", "cancelled", "skipped"],
	ready: ["running", "blocked", "cancelled", "skipped"],
	running: ["verifying", "ready", "succeeded", "blocked", "failed", "cancelled"],
	verifying: ["succeeded", "ready", "blocked", "failed", "cancelled"],
	blocked: ["pending", "ready", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
	skipped: [],
};

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
	queued: ["running", "cancelled", "interrupted"],
	running: ["waiting", "succeeded", "failed", "timed_out", "cancelled", "interrupted"],
	waiting: ["running", "succeeded", "failed", "timed_out", "cancelled", "interrupted"],
	succeeded: [],
	failed: [],
	timed_out: [],
	cancelled: [],
	interrupted: [],
};

function violation(code: string, message: string): DomainViolation {
	return { code, message };
}

function requireFact(
	violations: DomainViolation[],
	condition: boolean | undefined,
	code: string,
	message: string,
): void {
	if (!condition) {
		violations.push(violation(code, message));
	}
}

export function isWorkflowTerminalStatus(status: WorkflowStatus): boolean {
	return WORKFLOW_TRANSITIONS[status].length === 0;
}

export function isTaskTerminalStatus(status: TaskStatus): boolean {
	return TASK_TRANSITIONS[status].length === 0;
}

export function isAttemptTerminalStatus(status: AttemptStatus): boolean {
	return ATTEMPT_TRANSITIONS[status].length === 0;
}

export function validateRevisionTransition(currentRevision: number, nextRevision: number): readonly DomainViolation[] {
	if (!Number.isInteger(currentRevision) || currentRevision < 0) {
		return [violation("revision.invalid_current", "Current revision must be a non-negative integer")];
	}
	if (!Number.isInteger(nextRevision) || nextRevision !== currentRevision + 1) {
		return [violation("revision.invalid_next", "Next revision must increment current revision by exactly one")];
	}
	return [];
}

export function validateWorkflowTransition(
	from: WorkflowStatus,
	to: WorkflowStatus,
	facts: WorkflowTransitionFacts = {},
): readonly DomainViolation[] {
	if (!WORKFLOW_TRANSITIONS[from].includes(to)) {
		return [violation("workflow.invalid_transition", `Workflow cannot transition from ${from} to ${to}`)];
	}

	const violations: DomainViolation[] = [];

	if (from === "received" && to === "clarifying") {
		requireFact(
			violations,
			facts.clarificationRequired,
			"workflow.clarification_not_required",
			"Clarification must be required before entering clarifying",
		);
	}

	if ((from === "received" || from === "clarifying") && to === "planning") {
		if (from === "clarifying") {
			requireFact(
				violations,
				facts.clarificationComplete,
				"workflow.clarification_incomplete",
				"Required clarification must be complete",
			);
		}
		requireFact(violations, facts.planModeSelected, "workflow.plan_mode_required", "Plan mode must be selected");
		requireFact(violations, facts.rootTaskExists, "workflow.root_task_required", "A root task must exist");
	}

	if ((from === "received" || from === "clarifying") && to === "executing") {
		if (from === "clarifying") {
			requireFact(
				violations,
				facts.clarificationComplete,
				"workflow.clarification_incomplete",
				"Required clarification must be complete",
			);
		}
		requireFact(
			violations,
			facts.directModeSelected,
			"workflow.direct_mode_required",
			"Direct mode must be selected",
		);
		requireFact(violations, facts.rootTaskExists, "workflow.root_task_required", "A root task must exist");
	}

	if (from === "planning" && to === "awaiting_approval") {
		requireFact(violations, facts.planReady, "workflow.plan_required", "A valid plan must be ready");
		requireFact(
			violations,
			facts.planReadOnly,
			"workflow.plan_write_detected",
			"Planning must not perform write operations",
		);
	}

	if (from === "awaiting_approval" && to === "planning") {
		requireFact(
			violations,
			facts.replacementPlanCreated,
			"workflow.replacement_plan_required",
			"A replacement plan version must be created",
		);
	}

	if (from === "awaiting_approval" && to === "executing") {
		requireFact(
			violations,
			facts.planApproved,
			"workflow.plan_approval_required",
			"The current plan must be approved",
		);
		requireFact(violations, facts.taskGraphReady, "workflow.task_graph_required", "The task graph must be ready");
	}

	if (from === "executing" && to === "planning") {
		requireFact(
			violations,
			facts.writeOperationsStopped,
			"workflow.write_operations_active",
			"Write operations must stop before entering planning",
		);
	}

	if (to === "verifying") {
		requireFact(
			violations,
			facts.allRequiredTasksSucceeded,
			"workflow.tasks_incomplete",
			"All required tasks must succeed before verification",
		);
	}

	if (from === "verifying" && to === "executing") {
		requireFact(
			violations,
			facts.repairTaskCreated,
			"workflow.repair_task_required",
			"A repair task must exist before returning to execution",
		);
	}

	if (to === "blocked") {
		requireFact(
			violations,
			facts.blockedReasonPresent,
			"workflow.blocked_reason_required",
			"A blocked reason must be recorded",
		);
	}

	if (from === "blocked" && (to === "planning" || to === "executing" || to === "verifying")) {
		const explicitReplan = to === "planning" && facts.replanningRequested;
		if (explicitReplan) {
			requireFact(
				violations,
				facts.replacementPlanCreated,
				"workflow.replacement_plan_required",
				"A replacement plan version must be created",
			);
		} else {
			requireFact(
				violations,
				facts.blockResolved,
				"workflow.block_not_resolved",
				"The blocking condition must be resolved",
			);
		}
		if (!explicitReplan && facts.blockedResumeStatus !== to) {
			violations.push(
				violation(
					"workflow.invalid_resume_status",
					`Blocked workflow must resume to ${facts.blockedResumeStatus ?? "its recorded status"}`,
				),
			);
		}
	}

	if (to === "completed") {
		requireFact(
			violations,
			facts.completionGatePassed,
			"workflow.completion_gate_failed",
			"The completion gate must pass",
		);
	}

	if (to === "failed") {
		requireFact(
			violations,
			facts.failureTerminalCondition,
			"workflow.failure_not_terminal",
			"Workflow failure must be unrecoverable or have exhausted its limits",
		);
		requireFact(
			violations,
			facts.runtimeResourcesStopped,
			"workflow.runtime_resources_active",
			"Runtime resources must stop before failure becomes terminal",
		);
	}

	if (to === "cancelling") {
		requireFact(
			violations,
			facts.cancellationRequested,
			"workflow.cancel_request_required",
			"A cancellation request must be persisted",
		);
	}

	if (to === "cancelled") {
		requireFact(
			violations,
			facts.runtimeResourcesStopped,
			"workflow.runtime_resources_active",
			"Runtime resources must stop before cancellation becomes terminal",
		);
		requireFact(
			violations,
			facts.writerLeaseReleased,
			"workflow.writer_lease_active",
			"The writer lease must be released before cancellation becomes terminal",
		);
	}

	return violations;
}

export function validateTaskTransition(
	from: TaskStatus,
	to: TaskStatus,
	facts: TaskTransitionFacts = {},
): readonly DomainViolation[] {
	if (!TASK_TRANSITIONS[from].includes(to)) {
		return [violation("task.invalid_transition", `Task cannot transition from ${from} to ${to}`)];
	}

	const violations: DomainViolation[] = [];

	if (to === "ready") {
		requireFact(violations, facts.workflowExecuting, "task.workflow_not_executing", "Workflow must be executing");
		requireFact(
			violations,
			facts.dependenciesSucceeded,
			"task.dependencies_incomplete",
			"Task dependencies must succeed",
		);
		if (from === "blocked") {
			requireFact(
				violations,
				facts.blockResolved,
				"task.block_not_resolved",
				"The blocking condition must be resolved",
			);
		}
	}

	if (from === "blocked" && to === "pending") {
		requireFact(
			violations,
			facts.blockResolved,
			"task.block_not_resolved",
			"The blocking condition must be resolved",
		);
	}

	if (to === "running") {
		requireFact(violations, facts.attemptCreated, "task.attempt_required", "An attempt must be created");
		if (facts.controlTask) {
			violations.push(violation("task.control_not_executable", "Control tasks cannot be assigned to an executor"));
		}
		if (facts.writerLeaseRequired) {
			requireFact(violations, facts.writerLeaseHeld, "task.writer_lease_required", "The writer lease must be held");
		}
	}

	if (to === "verifying") {
		requireFact(violations, facts.attemptSucceeded, "task.attempt_not_succeeded", "The current attempt must succeed");
		requireFact(
			violations,
			facts.hasRequiredVerification,
			"task.verification_not_required",
			"Task has no required verification",
		);
	}

	if (to === "succeeded") {
		requireFact(violations, facts.attemptSucceeded, "task.attempt_not_succeeded", "The current attempt must succeed");
		requireFact(violations, facts.taskResultPresent, "task.result_required", "A task result must be present");
		if (from === "running" && facts.hasRequiredVerification) {
			violations.push(violation("task.verification_required", "Task must enter verifying before it can succeed"));
		}
		if (from === "verifying") {
			requireFact(
				violations,
				facts.requiredVerificationPassed,
				"task.verification_failed",
				"Required verification must pass",
			);
		}
	}

	if (to === "ready" && (from === "running" || from === "verifying")) {
		requireFact(violations, facts.retryAllowed, "task.retry_not_allowed", "A retry must be allowed");
	}

	if (to === "blocked") {
		requireFact(
			violations,
			facts.blockedReasonPresent,
			"task.blocked_reason_required",
			"A blocked reason must be recorded",
		);
	}

	if (to === "cancelled" || to === "failed") {
		if (to === "failed") {
			requireFact(
				violations,
				facts.failureTerminalCondition,
				"task.failure_not_terminal",
				"Task failure must be unrecoverable or have exhausted its retries",
			);
		}
		requireFact(
			violations,
			facts.activeAttemptStopped,
			"task.attempt_active",
			"The active attempt must stop before the task becomes terminal",
		);
	}

	if (to === "skipped") {
		requireFact(
			violations,
			facts.taskNoLongerRequired,
			"task.still_required",
			"Only a task that is no longer required can be skipped",
		);
	}

	return violations;
}

export function validateAttemptTransition(from: AttemptStatus, to: AttemptStatus): readonly DomainViolation[] {
	if (!ATTEMPT_TRANSITIONS[from].includes(to)) {
		return [violation("attempt.invalid_transition", `Attempt cannot transition from ${from} to ${to}`)];
	}
	return [];
}
