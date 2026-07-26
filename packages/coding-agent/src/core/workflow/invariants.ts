import type { DomainViolation } from "./transitions.ts";
import { isAttemptTerminalStatus, isWorkflowTerminalStatus } from "./transitions.ts";
import type { Attempt, BudgetLimit, EntityMetadata, ResourceUsage, Task, Workflow } from "./types.ts";
import { WORKFLOW_SCHEMA_VERSION } from "./types.ts";

function violation(code: string, message: string): DomainViolation {
	return { code, message };
}

function validateMetadata(metadata: EntityMetadata, entityName: string): DomainViolation[] {
	const violations: DomainViolation[] = [];
	if (metadata.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
		violations.push(
			violation(
				`${entityName}.unsupported_schema`,
				`${entityName} schema version ${metadata.schemaVersion} is not supported`,
			),
		);
	}
	if (!Number.isInteger(metadata.revision) || metadata.revision < 0) {
		violations.push(
			violation(`${entityName}.invalid_revision`, `${entityName} revision must be a non-negative integer`),
		);
	}
	if (metadata.createdAt.length === 0 || metadata.updatedAt.length === 0) {
		violations.push(violation(`${entityName}.timestamp_required`, `${entityName} timestamps are required`));
	}
	return violations;
}

function validateUsage(usage: ResourceUsage, entityName: string): DomainViolation[] {
	const values = [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheWriteTokens,
		usage.cost,
		usage.turns,
		usage.durationMs,
	];
	return values.some((value) => !Number.isFinite(value) || value < 0)
		? [violation(`${entityName}.invalid_usage`, `${entityName} resource usage must contain non-negative numbers`)]
		: [];
}

function validateBudget(budget: BudgetLimit, entityName: string): DomainViolation[] {
	const values = Object.values(budget);
	if (values.some((value) => !Number.isFinite(value) || value < 0)) {
		return [violation(`${entityName}.invalid_budget`, `${entityName} budget must contain non-negative numbers`)];
	}
	const integerValues = [
		budget.maxInputTokens,
		budget.maxOutputTokens,
		budget.maxTurns,
		budget.maxDurationMs,
		budget.maxConcurrentAgents,
		budget.maxConcurrentJobs,
		budget.maxAgentDepth,
		budget.maxRetries,
	].filter((value) => value !== undefined);
	return integerValues.some((value) => !Number.isInteger(value))
		? [violation(`${entityName}.invalid_budget`, `${entityName} count and duration limits must be integers`)]
		: [];
}

function hasDuplicates(values: readonly string[]): boolean {
	return new Set(values).size !== values.length;
}

export function validateWorkflow(workflow: Workflow): readonly DomainViolation[] {
	const violations = [
		...validateMetadata(workflow, "workflow"),
		...validateUsage(workflow.usage, "workflow"),
		...validateBudget(workflow.budget, "workflow"),
	];

	if (workflow.id.length === 0) {
		violations.push(violation("workflow.id_required", "Workflow id is required"));
	}
	if (workflow.request.text.trim().length === 0) {
		violations.push(violation("workflow.request_required", "Workflow request text is required"));
	}
	if (workflow.request.cwd.trim().length === 0) {
		violations.push(violation("workflow.cwd_required", "Workflow cwd is required"));
	}

	const requiresRootTask = [
		"planning",
		"awaiting_approval",
		"executing",
		"verifying",
		"blocked",
		"completed",
		"failed",
	].includes(workflow.status);
	if (requiresRootTask && !workflow.rootTaskId) {
		violations.push(violation("workflow.root_task_required", `Workflow ${workflow.status} requires a root task`));
	}

	const requiresModeDecision = requiresRootTask;
	if (requiresModeDecision && !workflow.modeDecision) {
		violations.push(
			violation("workflow.mode_decision_required", `Workflow ${workflow.status} requires a mode decision`),
		);
	}

	if ((workflow.status === "planning" || workflow.status === "awaiting_approval") && !workflow.currentPlanId) {
		violations.push(violation("workflow.plan_required", `Workflow ${workflow.status} requires a current plan`));
	}
	if (
		(workflow.status === "planning" || workflow.status === "awaiting_approval") &&
		workflow.modeDecision?.mode !== "plan"
	) {
		violations.push(violation("workflow.plan_mode_required", `Workflow ${workflow.status} requires plan mode`));
	}

	if (workflow.status === "blocked" && !workflow.blockedReason) {
		violations.push(violation("workflow.blocked_reason_required", "Blocked workflow requires a reason"));
	}
	if (workflow.status !== "blocked" && workflow.blockedReason) {
		violations.push(
			violation("workflow.unexpected_blocked_reason", "Only a blocked workflow can retain a blocked reason"),
		);
	}

	if (isWorkflowTerminalStatus(workflow.status)) {
		if (!workflow.result) {
			violations.push(violation("workflow.result_required", `Workflow ${workflow.status} requires a result`));
		} else if (workflow.result.status !== workflow.status) {
			violations.push(
				violation("workflow.result_status_mismatch", "Workflow result status must match workflow status"),
			);
		}
		if ((workflow.status === "failed" || workflow.status === "cancelled") && !workflow.result?.reason?.trim()) {
			violations.push(
				violation("workflow.terminal_reason_required", `Workflow ${workflow.status} requires a final reason`),
			);
		}
		if (workflow.result) {
			violations.push(...validateUsage(workflow.result.usage, "workflow.result"));
			if (!Number.isFinite(workflow.result.durationMs) || workflow.result.durationMs < 0) {
				violations.push(
					violation("workflow.result.invalid_duration", "Workflow result duration must be non-negative"),
				);
			}
		}
	} else if (workflow.result) {
		violations.push(violation("workflow.unexpected_result", "Non-terminal workflow cannot have a final result"));
	}

	return violations;
}

export function validateTask(task: Task): readonly DomainViolation[] {
	const violations = [
		...validateMetadata(task, "task"),
		...validateUsage(task.usage, "task"),
		...validateBudget(task.budget, "task"),
	];

	if (task.id.length === 0) {
		violations.push(violation("task.id_required", "Task id is required"));
	}
	if (task.workflowId.length === 0) {
		violations.push(violation("task.workflow_id_required", "Task workflow id is required"));
	}
	if (task.title.trim().length === 0) {
		violations.push(violation("task.title_required", "Task title is required"));
	}
	if (task.parentTaskId === task.id) {
		violations.push(violation("task.self_parent", "Task cannot be its own parent"));
	}
	if (task.dependencyIds.includes(task.id)) {
		violations.push(violation("task.self_dependency", "Task cannot depend on itself"));
	}
	if (hasDuplicates(task.dependencyIds)) {
		violations.push(violation("task.duplicate_dependency", "Task dependency ids must be unique"));
	}
	if (hasDuplicates(task.attemptIds)) {
		violations.push(violation("task.duplicate_attempt", "Task attempt ids must be unique"));
	}
	if (task.currentAttemptId && !task.attemptIds.includes(task.currentAttemptId)) {
		violations.push(violation("task.current_attempt_missing", "Current attempt must appear in attempt ids"));
	}
	if (task.kind === "control" && task.assignment) {
		violations.push(violation("task.control_assignment", "Control task cannot have an executor assignment"));
	}
	if (task.status === "blocked" && !task.blockedReason) {
		violations.push(violation("task.blocked_reason_required", "Blocked task requires a reason"));
	}
	if (task.status !== "blocked" && task.blockedReason) {
		violations.push(violation("task.unexpected_blocked_reason", "Only a blocked task can retain a blocked reason"));
	}
	if (task.status === "succeeded" && !task.result) {
		violations.push(violation("task.result_required", "Succeeded task requires a result"));
	}
	if (task.status !== "succeeded" && task.result) {
		violations.push(violation("task.unexpected_result", "Only a succeeded task can have a result"));
	}

	return violations;
}

export function validateAttempt(attempt: Attempt): readonly DomainViolation[] {
	const violations = [...validateMetadata(attempt, "attempt"), ...validateUsage(attempt.usage, "attempt")];

	if (attempt.id.length === 0) {
		violations.push(violation("attempt.id_required", "Attempt id is required"));
	}
	if (attempt.workflowId.length === 0 || attempt.taskId.length === 0) {
		violations.push(violation("attempt.owner_required", "Attempt workflow and task ids are required"));
	}
	if (!Number.isInteger(attempt.number) || attempt.number < 1) {
		violations.push(violation("attempt.invalid_number", "Attempt number must be a positive integer"));
	}
	if (attempt.status !== "queued" && !attempt.startedAt) {
		violations.push(violation("attempt.start_required", `Attempt ${attempt.status} requires a start time`));
	}
	if (isAttemptTerminalStatus(attempt.status) && !attempt.endedAt) {
		violations.push(violation("attempt.end_required", `Attempt ${attempt.status} requires an end time`));
	}
	if (attempt.status === "failed" && !attempt.failure) {
		violations.push(violation("attempt.failure_required", "Failed attempt requires a failure record"));
	}
	if (attempt.status !== "failed" && attempt.failure) {
		violations.push(violation("attempt.unexpected_failure", "Only a failed attempt can have a failure record"));
	}

	return violations;
}
