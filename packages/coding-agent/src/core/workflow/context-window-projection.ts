import type { WorkflowSnapshot } from "./stores.ts";
import type {
	Attempt,
	BudgetLimit,
	FileModificationRecord,
	Plan,
	Task,
	ToolOperationReceipt,
	VerificationResult,
	Workflow,
} from "./types.ts";

export const DEFAULT_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES = 12_000;
export const MIN_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES = 1_024;
export const DEFAULT_RECENT_WORKFLOW_CONTEXT_LIMIT = 3;
const DEFAULT_WORKFLOW_OBJECTIVE_MAX_BYTES = 1_024;
const MIN_WORKFLOW_OBJECTIVE_MAX_BYTES = 256;
const RECENT_WORKFLOW_OBJECTIVE_MAX_BYTES = 768;
const RECENT_WORKFLOW_RESULT_MAX_BYTES = 512;
const RECENT_WORKFLOW_FILE_LIMIT = 4;
const RECENT_WORKFLOW_UNFINISHED_LIMIT = 2;

export interface WorkflowContextProjection {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly snapshotSequence: number;
	readonly content: string;
	readonly truncated: boolean;
	readonly byteLength: number;
}

export interface WorkflowContextCheckpoint {
	readonly workflowId: string;
	readonly snapshotEntryId: string;
	readonly snapshot: WorkflowSnapshot;
	/** Recent persisted Workflow state projected only for cross-request continuity. */
	readonly recentWorkflowSnapshots?: readonly WorkflowSnapshot[];
}

export interface WorkflowContextProvider {
	/** Available on recovered/runtime providers that can report whether work is settled. */
	readonly isTerminal?: boolean;
	checkpointForContextWindow(): WorkflowContextCheckpoint | undefined;
}

interface ProjectionLine {
	readonly content: string;
	readonly required: boolean;
}

interface WorkflowSnapshotSource {
	listWorkflows(): readonly Workflow[];
	createSnapshot(workflowId: string): WorkflowSnapshot;
}

export function selectRecentWorkflowSnapshots(
	source: WorkflowSnapshotSource,
	currentWorkflowId: string,
	limit = DEFAULT_RECENT_WORKFLOW_CONTEXT_LIMIT,
): readonly WorkflowSnapshot[] {
	if (!Number.isSafeInteger(limit) || limit < 0) {
		throw new Error("Recent Workflow context limit must be a non-negative safe integer");
	}
	return source
		.listWorkflows()
		.filter(({ id, result }) => id !== currentWorkflowId && result !== undefined)
		.sort(
			(left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id),
		)
		.slice(0, limit)
		.map(({ id }) => source.createSnapshot(id));
}

function truncateField(value: string, maxBytes = 256): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
	const suffix = "...";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	let result = "";
	for (const character of normalized) {
		if (Buffer.byteLength(result + character, "utf8") + suffixBytes > maxBytes) break;
		result += character;
	}
	return result + suffix;
}

function truncateObjective(value: string, maxBytes = 256): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
	const separator = " ... ";
	const availableBytes = maxBytes - Buffer.byteLength(separator, "utf8");
	const headBytes = Math.floor(availableBytes / 3);
	const tailBytes = availableBytes - headBytes;
	let head = "";
	for (const character of normalized) {
		if (Buffer.byteLength(head + character, "utf8") > headBytes) break;
		head += character;
	}
	let tail = "";
	for (const character of [...normalized].reverse()) {
		if (Buffer.byteLength(character + tail, "utf8") > tailBytes) break;
		tail = character + tail;
	}
	return head + separator + tail;
}

function formatBudget(budget: BudgetLimit): string {
	const fields: string[] = [];
	for (const [name, value] of [
		["input", budget.maxInputTokens],
		["output", budget.maxOutputTokens],
		["cost", budget.maxCost],
		["turns", budget.maxTurns],
		["durationMs", budget.maxDurationMs],
		["agents", budget.maxConcurrentAgents],
		["jobs", budget.maxConcurrentJobs],
		["depth", budget.maxAgentDepth],
		["retries", budget.maxRetries],
	] as const) {
		if (value !== undefined) fields.push(`${name}=${value}`);
	}
	return fields.length > 0 ? fields.join(",") : "unbounded";
}

function selectCurrentPlan(snapshot: WorkflowSnapshot): Plan | undefined {
	const currentPlanId = snapshot.workflow.currentPlanId;
	if (currentPlanId) return snapshot.plans.find(({ id }) => id === currentPlanId);
	return [...snapshot.plans].sort((left, right) => right.version - left.version || left.id.localeCompare(right.id))[0];
}

function selectLatestAttempts(snapshot: WorkflowSnapshot): Attempt[] {
	const attemptsByTask = new Map<string, Attempt[]>();
	for (const attempt of snapshot.attempts) {
		const attempts = attemptsByTask.get(attempt.taskId) ?? [];
		attempts.push(attempt);
		attemptsByTask.set(attempt.taskId, attempts);
	}
	const selected: Attempt[] = [];
	for (const task of [...snapshot.tasks].sort((left, right) => left.id.localeCompare(right.id))) {
		const attempts = attemptsByTask.get(task.id);
		if (!attempts || attempts.length === 0) continue;
		const current = task.currentAttemptId ? attempts.find(({ id }) => id === task.currentAttemptId) : undefined;
		selected.push(
			current ??
				[...attempts].sort((left, right) => right.number - left.number || left.id.localeCompare(right.id))[0],
		);
	}
	return selected;
}

function deriveNextAction(
	workflow: Workflow,
	tasks: readonly Task[],
	verifications: readonly VerificationResult[],
	unchecked: readonly string[],
): string {
	switch (workflow.status) {
		case "received":
		case "clarifying":
		case "planning":
			return "Complete the current planning or clarification step.";
		case "awaiting_approval":
			return "Wait for or process the user's plan decision.";
		case "executing": {
			const active = tasks.find(({ status }) => status === "running" || status === "verifying");
			if (active) return `Continue workflow_task_id=${active.id}: ${truncateField(active.title)}`;
			const ready = tasks.find(({ status }) => status === "ready");
			if (ready) return `Dispatch workflow_task_id=${ready.id}: ${truncateField(ready.title)}`;
			return "Reconcile task states and determine the next executable task.";
		}
		case "verifying": {
			const pending = verifications.find(({ status }) => status !== "passed");
			if (pending) return `Continue workflow_verification_id=${pending.id}: ${truncateField(pending.summary)}`;
			if (unchecked.length > 0) return `Complete unchecked verification before finalizing: ${unchecked[0]}`;
			return "Reconcile verification results and finalize the workflow.";
		}
		case "blocked":
			return `Resolve the workflow block: ${truncateField(workflow.blockedReason?.message ?? "unknown reason")}`;
		case "cancelling":
			return "Finish cancellation and persist terminal state.";
		case "completed":
		case "failed":
		case "cancelled":
			return "The workflow is terminal; do not resume work unless the user requests it.";
	}
}

function taskLine(task: Task, currentObjective: string): string {
	const dependencies = [...task.dependencyIds].sort().join(",") || "none";
	const blocked = task.blockedReason ? ` blocked=${truncateField(task.blockedReason.message)}` : "";
	const description =
		task.description.replace(/\s+/g, " ").trim() === currentObjective.replace(/\s+/g, " ").trim()
			? ""
			: ` description=${JSON.stringify(truncateObjective(task.description, 512))}`;
	const result = task.result ? ` result=${JSON.stringify(truncateObjective(task.result.summary, 512))}` : "";
	return `Workflow Task: workflow_task_id=${task.id} title=${truncateField(task.title)} kind=${task.kind} status=${task.status} workflow_task_dependency_ids=${dependencies} current_workflow_attempt_id=${task.currentAttemptId ?? "none"}${description}${blocked}${result}`;
}

function attemptLine(attempt: Attempt): string {
	const failure = attempt.failure
		? ` failure=${attempt.failure.code}:${truncateField(attempt.failure.message)} retryable=${attempt.failure.retryable}`
		: "";
	return `Workflow Attempt: workflow_attempt_id=${attempt.id} workflow_task_id=${attempt.taskId} number=${attempt.number} status=${attempt.status} executor=${attempt.executorKind} usage=input:${attempt.usage.inputTokens},output:${attempt.usage.outputTokens},turns:${attempt.usage.turns},cost:${attempt.usage.cost}${failure}`;
}

function verificationLine(verification: VerificationResult): string {
	const evidence =
		[...verification.evidenceRefs]
			.sort()
			.map((value) => truncateField(value))
			.join(",") || "none";
	return `Workflow Verification: workflow_verification_id=${verification.id} workflow_task_id=${verification.taskId ?? "none"} requirement=${verification.requirementId} status=${verification.status} summary=${truncateField(verification.summary)} evidence=${evidence}`;
}

function modificationLine(modification: FileModificationRecord): string {
	return `Observed modification: path=${JSON.stringify(truncateField(modification.path))} operation=${modification.operation} workflow_task_id=${modification.taskId} workflow_attempt_id=${modification.attemptId}`;
}

function operationReceiptLine(receipt: ToolOperationReceipt): string {
	return `Workflow Operation Receipt: kind=${receipt.kind} tool=${receipt.toolName} status=${receipt.status} input=${JSON.stringify(truncateField(receipt.inputSummary, 192))} result=${JSON.stringify(truncateField(receipt.resultSummary, 256))} workflow_task_id=${receipt.taskId} workflow_attempt_id=${receipt.attemptId} tool_call_id=${receipt.toolCallId}`;
}

function recentWorkflowLine(snapshot: WorkflowSnapshot): string {
	const workflow = snapshot.workflow;
	const result = workflow.result;
	const changedFiles =
		result?.changedFiles.slice(0, RECENT_WORKFLOW_FILE_LIMIT).map((path) => truncateField(path, 128)) ?? [];
	if (result && result.changedFiles.length > changedFiles.length) {
		changedFiles.push(`+${result.changedFiles.length - changedFiles.length} more`);
	}
	const unfinished =
		result?.unfinishedItems.slice(0, RECENT_WORKFLOW_UNFINISHED_LIMIT).map((item) => truncateField(item, 160)) ?? [];
	if (result && result.unfinishedItems.length > unfinished.length) {
		unfinished.push(`+${result.unfinishedItems.length - unfinished.length} more`);
	}
	return `Recent Workflow Context: workflow_id=${workflow.id} status=${workflow.status} user_objective=${JSON.stringify(truncateObjective(workflow.request.text, RECENT_WORKFLOW_OBJECTIVE_MAX_BYTES))} recorded_result=${JSON.stringify(truncateObjective(result?.summary ?? result?.reason ?? "none", RECENT_WORKFLOW_RESULT_MAX_BYTES))} changed_files=${JSON.stringify(changedFiles)} unfinished=${JSON.stringify(unfinished)}`;
}

export function projectWorkflowSnapshot(
	snapshot: WorkflowSnapshot,
	maxBytes = DEFAULT_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES,
	recentWorkflowSnapshots: readonly WorkflowSnapshot[] = [],
): WorkflowContextProjection {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES) {
		throw new Error(
			`Workflow context projection maxBytes must be a safe integer >= ${MIN_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES}`,
		);
	}

	const workflow = snapshot.workflow;
	if (snapshot.workflowId !== workflow.id) {
		throw new Error("Workflow Snapshot workflowId does not match its Workflow projection");
	}
	const plan = selectCurrentPlan(snapshot);
	const tasks = [...snapshot.tasks].sort((left, right) => left.id.localeCompare(right.id));
	const attempts = selectLatestAttempts(snapshot);
	const operationReceipts = tasks
		.flatMap((task) => task.operationReceipts ?? [])
		.sort(
			(left, right) =>
				Date.parse(right.recordedAt) - Date.parse(left.recordedAt) ||
				left.toolCallId.localeCompare(right.toolCallId),
		);
	const recentWorkflows = [...recentWorkflowSnapshots]
		.filter(({ workflowId }) => workflowId !== workflow.id)
		.sort(
			(left, right) =>
				Date.parse(right.workflow.updatedAt) - Date.parse(left.workflow.updatedAt) ||
				right.workflowId.localeCompare(left.workflowId),
		)
		.slice(0, DEFAULT_RECENT_WORKFLOW_CONTEXT_LIMIT);
	const modifications = tasks
		.flatMap((task) => task.modifications)
		.sort(
			(left, right) =>
				Date.parse(right.recordedAt) - Date.parse(left.recordedAt) ||
				left.path.localeCompare(right.path) ||
				left.toolCallId.localeCompare(right.toolCallId),
		)
		.filter(
			(modification, index, all) =>
				all.findIndex(
					(candidate) => candidate.taskId === modification.taskId && candidate.path === modification.path,
				) === index,
		);
	const verifications = snapshot.verifications
		.map(({ result }) => result)
		.sort(
			(left, right) =>
				Number(left.status === "passed") - Number(right.status === "passed") || left.id.localeCompare(right.id),
		);
	const unchecked = [
		...(plan?.verificationRequirements ?? [])
			.filter(
				(requirement) => !verifications.some((result) => result.requirementId === requirement.id && !result.taskId),
			)
			.map((requirement) => `Not checked: requirement=${requirement.id} ${truncateField(requirement.description)}`),
		...tasks.flatMap((task) =>
			task.verificationRequirements
				.filter(
					(requirement) =>
						!verifications.some((result) => result.requirementId === requirement.id && result.taskId === task.id),
				)
				.map(
					(requirement) =>
						`Not checked: workflow_task_id=${task.id} requirement=${requirement.id} ${truncateField(requirement.description)}`,
				),
		),
	];
	const mode = workflow.modeDecision?.mode ?? "undecided";
	const stopReason = workflow.result?.reason ?? workflow.blockedReason?.message ?? "none";
	const objectiveMaxBytes = Math.min(
		DEFAULT_WORKFLOW_OBJECTIVE_MAX_BYTES,
		Math.max(MIN_WORKFLOW_OBJECTIVE_MAX_BYTES, Math.floor(maxBytes / 4)),
	);
	const assumptions = plan
		? [...plan.assumptions]
				.sort()
				.map((value) => truncateField(value))
				.join(" | ") || "none"
		: "none";

	const lines: ProjectionLine[] = [
		{
			content: "Workflow Snapshot is task-control authority; Workspace/diff is current-code authority:",
			required: true,
		},
		{
			content: "Internal workflow_* IDs are control-plane IDs, not user-domain identifiers.",
			required: true,
		},
		{
			content: `Workflow: workflow_id=${workflow.id} mode=${mode} status=${workflow.status} sequence=${snapshot.lastSequence}`,
			required: true,
		},
		{ content: `Current objective: ${truncateObjective(workflow.request.text, objectiveMaxBytes)}`, required: true },
		{ content: `Stop/block: ${truncateField(stopReason)}`, required: true },
		{
			content: plan
				? `Plan: workflow_plan_id=${plan.id} version=${plan.version} status=${plan.status} goal=${truncateField(plan.goal)}`
				: "Plan: none",
			required: true,
		},
		{
			content: `Constraints: workflowBudget=${formatBudget(workflow.budget)} assumptions=${assumptions}`,
			required: true,
		},
		{ content: `Next action: ${deriveNextAction(workflow, tasks, verifications, unchecked)}`, required: true },
		...operationReceipts.map((receipt) => ({ content: operationReceiptLine(receipt), required: false })),
		{
			content:
				"Recovery order: trust Workflow Operation Receipts for whether marked one-shot/verification calls ran; do not query Notes or History merely to reconfirm them, and do not repeat a receipt-bearing call solely to rediscover its result. Use Workspace/diff for current code, Notes for durable design semantics, and History only when exact unavailable prior evidence is required.",
			required: false,
		},
		...verifications
			.filter(({ status }) => status !== "passed")
			.map((verification) => ({ content: verificationLine(verification), required: false })),
		...unchecked.map((content) => ({ content, required: false })),
		...recentWorkflows.map((recent) => ({ content: recentWorkflowLine(recent), required: false })),
		...modifications.map((modification) => ({ content: modificationLine(modification), required: false })),
		{
			content:
				"Verification scope: changed code and runtime success do not establish test coverage. Resolve unchecked work from the Current objective before final submission. Use History only when an exact required detail is absent. Existing-suite success alone does not resolve untested requirements.",
			required: false,
		},
		...tasks.map((task) => ({ content: taskLine(task, workflow.request.text), required: false })),
		...verifications
			.filter(({ status }) => status === "passed")
			.map((verification) => ({ content: verificationLine(verification), required: false })),
		...attempts.map((attempt) => ({ content: attemptLine(attempt), required: false })),
		{
			content:
				"Observed edit/write paths may be incomplete. Use Workspace/diff for current code; use History only for unavailable prior evidence.",
			required: true,
		},
	];

	const requiredLines = lines.filter(({ required }) => required);
	const optionalLines = lines.filter(({ required }) => !required);
	const optionalInsertionIndex = 8;
	const marker = (omitted: number): ProjectionLine => ({
		content: `[projection truncated: omitted ${omitted} detail line(s)]`,
		required: true,
	});
	const selectedOptional: ProjectionLine[] = [];
	for (const line of optionalLines) {
		const omitted = optionalLines.length - selectedOptional.length - 1;
		const candidate = [
			...requiredLines.slice(0, optionalInsertionIndex),
			...selectedOptional,
			line,
			...(omitted > 0 ? [marker(omitted)] : []),
			...requiredLines.slice(optionalInsertionIndex),
		];
		if (Buffer.byteLength(candidate.map(({ content }) => content).join("\n"), "utf8") > maxBytes) break;
		selectedOptional.push(line);
	}
	const omitted = optionalLines.length - selectedOptional.length;
	const selected = [
		...requiredLines.slice(0, optionalInsertionIndex),
		...selectedOptional,
		...(omitted > 0 ? [marker(omitted)] : []),
		...requiredLines.slice(optionalInsertionIndex),
	];
	const content = selected.map((line) => line.content).join("\n");
	const byteLength = Buffer.byteLength(content, "utf8");
	if (byteLength > maxBytes) {
		throw new Error(`Workflow context projection requires at least ${byteLength} bytes for authoritative fields`);
	}
	return {
		schemaVersion: 1,
		workflowId: workflow.id,
		snapshotSequence: snapshot.lastSequence,
		content,
		truncated: omitted > 0,
		byteLength,
	};
}
