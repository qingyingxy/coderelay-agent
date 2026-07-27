import type { DomainViolation } from "./transitions.ts";
import { isAttemptTerminalStatus, isWorkflowTerminalStatus } from "./transitions.ts";
import type {
	Attempt,
	BudgetLimit,
	EntityMetadata,
	Plan,
	PlanStep,
	ResourceUsage,
	Task,
	VerificationRequirement,
	Workflow,
} from "./types.ts";
import { FILE_INTENT_ACTIONS, PLAN_STATUSES, WORKFLOW_SCHEMA_VERSION } from "./types.ts";

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

function validateVerificationRequirement(
	requirement: VerificationRequirement,
	entityName: string,
): readonly DomainViolation[] {
	const violations: DomainViolation[] = [];
	if (!requirement.id.trim()) {
		violations.push(violation(`${entityName}.verification_id_required`, "Verification requirement id is required"));
	}
	if (!requirement.description.trim()) {
		violations.push(
			violation(`${entityName}.verification_description_required`, "Verification description is required"),
		);
	}
	if (requirement.command !== undefined && !requirement.command.trim()) {
		violations.push(violation(`${entityName}.verification_command_required`, "Verification command cannot be empty"));
	}
	return violations;
}

function validatePlanStep(
	step: PlanStep,
	stepIds: ReadonlySet<string>,
	verificationIds: ReadonlySet<string>,
): readonly DomainViolation[] {
	const violations: DomainViolation[] = [];
	if (!step.id.trim()) {
		violations.push(violation("plan.step_id_required", "Plan step id is required"));
	}
	if (!step.title.trim() || !step.description.trim()) {
		violations.push(violation("plan.step_content_required", `Plan step ${step.id} requires a title and description`));
	}
	const stepKind = step.kind ?? "agent";
	if (stepKind !== "agent" && stepKind !== "command") {
		violations.push(violation("plan.step_kind_invalid", `Plan step ${step.id} has an invalid kind`));
	}
	if (stepKind === "command" && !step.command?.trim()) {
		violations.push(violation("plan.step_command_required", `Command Plan step ${step.id} requires a command`));
	}
	if (stepKind === "command" && step.verificationRequirementIds.length === 0) {
		violations.push(
			violation("plan.step_verification_required", `Command Plan step ${step.id} requires verification`),
		);
	}
	if (stepKind !== "command" && step.command !== undefined) {
		violations.push(violation("plan.step_unexpected_command", `Agent Plan step ${step.id} cannot define a command`));
	}
	if (hasDuplicates(step.dependsOn)) {
		violations.push(violation("plan.duplicate_step_dependency", `Plan step ${step.id} dependencies must be unique`));
	}
	if (step.dependsOn.includes(step.id)) {
		violations.push(violation("plan.self_step_dependency", `Plan step ${step.id} cannot depend on itself`));
	}
	for (const dependencyId of step.dependsOn) {
		if (!stepIds.has(dependencyId)) {
			violations.push(
				violation("plan.step_dependency_missing", `Plan step ${step.id} references missing step ${dependencyId}`),
			);
		}
	}
	if (hasDuplicates(step.verificationRequirementIds)) {
		violations.push(
			violation("plan.duplicate_step_verification", `Plan step ${step.id} verification ids must be unique`),
		);
	}
	for (const verificationId of step.verificationRequirementIds) {
		if (!verificationIds.has(verificationId)) {
			violations.push(
				violation(
					"plan.step_verification_missing",
					`Plan step ${step.id} references missing verification ${verificationId}`,
				),
			);
		}
	}
	for (const intent of step.fileIntents) {
		if (!intent.path.trim() || !intent.reason.trim()) {
			violations.push(
				violation("plan.file_intent_invalid", `Plan step ${step.id} file intents require a path and reason`),
			);
		}
		if (!FILE_INTENT_ACTIONS.some((action) => action === intent.action)) {
			violations.push(
				violation("plan.file_intent_action_invalid", `Plan step ${step.id} has an invalid file intent action`),
			);
		}
	}
	return violations;
}

function hasPlanStepCycle(steps: readonly PlanStep[]): boolean {
	const dependencies = new Map(steps.map((step) => [step.id, step.dependsOn]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (stepId: string): boolean => {
		if (visiting.has(stepId)) {
			return true;
		}
		if (visited.has(stepId)) {
			return false;
		}
		visiting.add(stepId);
		for (const dependencyId of dependencies.get(stepId) ?? []) {
			if (dependencies.has(dependencyId) && visit(dependencyId)) {
				return true;
			}
		}
		visiting.delete(stepId);
		visited.add(stepId);
		return false;
	};
	return steps.some((step) => visit(step.id));
}

export function validatePlan(plan: Plan): readonly DomainViolation[] {
	const violations = [...validateMetadata(plan, "plan")];
	if (!plan.id.trim()) {
		violations.push(violation("plan.id_required", "Plan id is required"));
	}
	if (!plan.workflowId.trim()) {
		violations.push(violation("plan.workflow_id_required", "Plan workflow id is required"));
	}
	if (!Number.isInteger(plan.version) || plan.version < 1) {
		violations.push(violation("plan.invalid_version", "Plan version must be a positive integer"));
	}
	if (plan.supersedesPlanId === plan.id) {
		violations.push(violation("plan.self_supersedes", "Plan cannot supersede itself"));
	}
	if (!PLAN_STATUSES.some((status) => status === plan.status)) {
		violations.push(violation("plan.invalid_status", `Plan status ${plan.status} is not supported`));
	}
	if (plan.assumptions.some((assumption) => !assumption.trim())) {
		violations.push(violation("plan.invalid_assumption", "Plan assumptions cannot be empty"));
	}
	for (const decision of plan.decisionHistory) {
		if (
			!["approved", "rejected", "revision_requested"].includes(decision.action) ||
			!decision.comment.trim() ||
			!Number.isFinite(Date.parse(decision.decidedAt))
		) {
			violations.push(violation("plan.invalid_decision", "Plan decision history contains an invalid record"));
		}
	}
	const finalDecision = plan.decisionHistory.at(-1);
	if (plan.status === "approved" && finalDecision?.action !== "approved") {
		violations.push(violation("plan.approval_record_required", "Approved Plan requires an approval record"));
	}
	if (plan.status === "rejected" && finalDecision?.action !== "rejected") {
		violations.push(violation("plan.rejection_record_required", "Rejected Plan requires a rejection record"));
	}
	if (plan.status === "superseded" && finalDecision?.action !== "revision_requested") {
		violations.push(violation("plan.revision_record_required", "Superseded Plan requires a revision record"));
	}

	const stepIds = new Set(plan.steps.map(({ id }) => id));
	if (stepIds.size !== plan.steps.length) {
		violations.push(violation("plan.duplicate_step", "Plan step ids must be unique"));
	}
	const verificationIds = new Set(plan.verificationRequirements.map(({ id }) => id));
	if (verificationIds.size !== plan.verificationRequirements.length) {
		violations.push(violation("plan.duplicate_verification", "Plan verification ids must be unique"));
	}
	for (const requirement of plan.verificationRequirements) {
		violations.push(...validateVerificationRequirement(requirement, "plan"));
	}
	for (const step of plan.steps) {
		violations.push(...validatePlanStep(step, stepIds, verificationIds));
	}
	if (hasPlanStepCycle(plan.steps)) {
		violations.push(violation("plan.step_cycle", "Plan step dependencies must be acyclic"));
	}
	for (const risk of plan.risks) {
		if (!risk.description.trim() || !risk.mitigation.trim()) {
			violations.push(violation("plan.risk_invalid", "Plan risks require a description and mitigation"));
		}
		if (!["low", "medium", "high"].includes(risk.level)) {
			violations.push(violation("plan.risk_level_invalid", "Plan risk level is not supported"));
		}
	}

	if (plan.status !== "draft") {
		if (!plan.goal.trim()) {
			violations.push(violation("plan.goal_required", `Plan ${plan.status} requires a goal`));
		}
		if (plan.steps.length === 0) {
			violations.push(violation("plan.steps_required", `Plan ${plan.status} requires at least one step`));
		}
		if (plan.verificationRequirements.length === 0) {
			violations.push(
				violation("plan.verification_required", `Plan ${plan.status} requires verification requirements`),
			);
		}
	}
	return violations;
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
	if (workflow.directPlanUpgradeRequest) {
		const request = workflow.directPlanUpgradeRequest;
		if (
			!request.reason.trim() ||
			!["low", "medium", "high"].includes(request.riskLevel) ||
			request.triggers.length === 0 ||
			request.triggers.some((trigger) => !["complexity", "risk", "confidence"].includes(trigger)) ||
			!Number.isFinite(Date.parse(request.requestedAt))
		) {
			violations.push(
				violation("workflow.invalid_direct_plan_upgrade_request", "Direct Plan upgrade request is invalid"),
			);
		}
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
	for (const modification of task.modifications) {
		if (
			!modification.path.trim() ||
			!modification.toolCallId.trim() ||
			!modification.agentId.trim() ||
			modification.workflowId !== task.workflowId ||
			modification.taskId !== task.id ||
			!task.attemptIds.includes(modification.attemptId) ||
			!["edit", "write"].includes(modification.operation) ||
			!Number.isFinite(Date.parse(modification.recordedAt))
		) {
			violations.push(
				violation("task.invalid_modification", `Task ${task.id} contains an invalid modification record`),
			);
		}
	}
	if (task.currentAttemptId && !task.attemptIds.includes(task.currentAttemptId)) {
		violations.push(violation("task.current_attempt_missing", "Current attempt must appear in attempt ids"));
	}
	if (task.kind === "control" && task.assignment) {
		violations.push(violation("task.control_assignment", "Control task cannot have an executor assignment"));
	}
	if (task.kind === "command" && !task.command?.trim()) {
		violations.push(violation("task.command_required", "Command Task requires a command"));
	}
	if (task.kind !== "command" && task.command !== undefined) {
		violations.push(violation("task.unexpected_command", "Only a Command Task can define a command"));
	}
	if (
		task.assignment?.agentDepth !== undefined &&
		(!Number.isInteger(task.assignment.agentDepth) || task.assignment.agentDepth < 0)
	) {
		violations.push(violation("task.invalid_agent_depth", "Task assignment Agent depth must be non-negative"));
	}
	if (task.accessMode !== "read_only" && task.accessMode !== "writer") {
		violations.push(violation("task.invalid_access_mode", `Task access mode ${task.accessMode} is not supported`));
	}
	if (task.kind === "control" && task.accessMode !== "read_only") {
		violations.push(violation("task.control_access_mode", "Control task must use read-only access"));
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
	if (
		attempt.status !== "queued" &&
		attempt.status !== "cancelled" &&
		attempt.status !== "interrupted" &&
		!attempt.startedAt
	) {
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
