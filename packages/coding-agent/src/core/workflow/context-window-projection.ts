import type { WorkflowSnapshot } from "./stores.ts";
import type { Attempt, BudgetLimit, Plan, Task, VerificationResult, Workflow } from "./types.ts";

export const DEFAULT_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES = 12_000;
export const MIN_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES = 1_024;

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
}

export interface WorkflowContextProvider {
	checkpointForContextWindow(): WorkflowContextCheckpoint | undefined;
}

interface ProjectionLine {
	readonly content: string;
	readonly required: boolean;
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
			if (active) return `Continue Task ${active.id}: ${truncateField(active.title)}`;
			const ready = tasks.find(({ status }) => status === "ready");
			if (ready) return `Dispatch Task ${ready.id}: ${truncateField(ready.title)}`;
			return "Reconcile task states and determine the next executable task.";
		}
		case "verifying": {
			const pending = verifications.find(({ status }) => status === "not_started" || status === "running");
			return pending
				? `Continue Verification ${pending.id}: ${truncateField(pending.summary)}`
				: "Reconcile verification results and finalize the workflow.";
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

function taskLine(task: Task): string {
	const dependencies = [...task.dependencyIds].sort().join(",") || "none";
	const blocked = task.blockedReason ? ` blocked=${truncateField(task.blockedReason.message)}` : "";
	const result = task.result ? ` result=${truncateField(task.result.summary)}` : "";
	return `Task ${task.id}: title=${truncateField(task.title)} kind=${task.kind} status=${task.status} dependencies=${dependencies} currentAttempt=${task.currentAttemptId ?? "none"}${blocked}${result}`;
}

function attemptLine(attempt: Attempt): string {
	const failure = attempt.failure
		? ` failure=${attempt.failure.code}:${truncateField(attempt.failure.message)} retryable=${attempt.failure.retryable}`
		: "";
	return `Attempt ${attempt.id}: task=${attempt.taskId} number=${attempt.number} status=${attempt.status} executor=${attempt.executorKind} usage=input:${attempt.usage.inputTokens},output:${attempt.usage.outputTokens},turns:${attempt.usage.turns},cost:${attempt.usage.cost}${failure}`;
}

function verificationLine(verification: VerificationResult): string {
	const evidence =
		[...verification.evidenceRefs]
			.sort()
			.map((value) => truncateField(value))
			.join(",") || "none";
	return `Verification ${verification.id}: task=${verification.taskId ?? "workflow"} requirement=${verification.requirementId} status=${verification.status} summary=${truncateField(verification.summary)} evidence=${evidence}`;
}

export function projectWorkflowSnapshot(
	snapshot: WorkflowSnapshot,
	maxBytes = DEFAULT_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES,
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
	const verifications = snapshot.verifications
		.map(({ result }) => result)
		.sort((left, right) => left.id.localeCompare(right.id));
	const mode = workflow.modeDecision?.mode ?? "undecided";
	const stopReason = workflow.result?.reason ?? workflow.blockedReason?.message ?? "none";
	const assumptions = plan
		? [...plan.assumptions]
				.sort()
				.map((value) => truncateField(value))
				.join(" | ") || "none"
		: "none";

	const lines: ProjectionLine[] = [
		{ content: "Context window continuity seed (Workflow Snapshot is authoritative):", required: true },
		{
			content: `Workflow: id=${workflow.id} mode=${mode} status=${workflow.status} sequence=${snapshot.lastSequence}`,
			required: true,
		},
		{ content: `Current objective: ${truncateField(workflow.request.text)}`, required: true },
		{ content: `Stop/block reason: ${truncateField(stopReason)}`, required: true },
		{
			content: plan
				? `Current plan: id=${plan.id} version=${plan.version} status=${plan.status} goal=${truncateField(plan.goal)}`
				: "Current plan: none",
			required: true,
		},
		...tasks.map((task) => ({ content: taskLine(task), required: false })),
		...attempts.map((attempt) => ({ content: attemptLine(attempt), required: false })),
		...verifications.map((verification) => ({ content: verificationLine(verification), required: false })),
		{
			content: `Active constraints: workflowBudget=${formatBudget(workflow.budget)} assumptions=${assumptions}`,
			required: true,
		},
		{ content: `Next action: ${deriveNextAction(workflow, tasks, verifications)}`, required: true },
		{
			content: "History: use the history tool when an exact prior message or tool result is needed.",
			required: true,
		},
	];

	const requiredLines = lines.filter(({ required }) => required);
	const optionalLines = lines.filter(({ required }) => !required);
	const marker = (omitted: number): ProjectionLine => ({
		content: `[projection truncated: omitted ${omitted} detail line(s)]`,
		required: true,
	});
	const selectedOptional: ProjectionLine[] = [];
	for (const line of optionalLines) {
		const omitted = optionalLines.length - selectedOptional.length - 1;
		const candidate = [
			...requiredLines.slice(0, 5),
			...selectedOptional,
			line,
			...(omitted > 0 ? [marker(omitted)] : []),
			...requiredLines.slice(5),
		];
		if (Buffer.byteLength(candidate.map(({ content }) => content).join("\n"), "utf8") > maxBytes) break;
		selectedOptional.push(line);
	}
	const omitted = optionalLines.length - selectedOptional.length;
	const selected = [
		...requiredLines.slice(0, 5),
		...selectedOptional,
		...(omitted > 0 ? [marker(omitted)] : []),
		...requiredLines.slice(5),
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
