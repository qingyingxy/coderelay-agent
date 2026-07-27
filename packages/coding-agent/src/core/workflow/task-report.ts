import { createTaskGraph } from "./task-graph.ts";
import type { Attempt, Task, TaskId, VerificationResult, WorkflowId } from "./types.ts";

const STATUS_MARKERS: Readonly<Record<Task["status"], string>> = {
	pending: "○",
	ready: "◇",
	running: "▶",
	verifying: "◆",
	blocked: "!",
	succeeded: "✓",
	failed: "×",
	cancelled: "−",
	skipped: "·",
};

export interface TaskReportContext {
	readonly attempts?: readonly Attempt[];
	readonly verifications?: readonly VerificationResult[];
}

export function formatTaskTree(
	workflowId: WorkflowId,
	tasks: readonly Task[],
	context: TaskReportContext = {},
): readonly string[] {
	const graph = createTaskGraph(workflowId, tasks);
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	const lines: string[] = [];
	const append = (taskId: TaskId, depth: number): void => {
		const task = tasksById.get(taskId);
		if (!task) {
			return;
		}
		const assignmentId = task.assignment?.agentId ?? task.assignment?.jobId;
		const executor = task.assignment
			? `${task.assignment.executorKind}${assignmentId ? `:${assignmentId}` : ""}`
			: "(unassigned)";
		const attempts = context.attempts?.filter(({ taskId: ownerTaskId }) => ownerTaskId === task.id) ?? [];
		const verifications = context.verifications?.filter(({ taskId: ownerTaskId }) => ownerTaskId === task.id) ?? [];
		const latestVerification = verifications.at(-1);
		lines.push(
			`${"  ".repeat(depth)}${STATUS_MARKERS[task.status]} ${task.id} | ${task.status} | ${task.kind}/${task.accessMode} | deps ${task.dependencyIds.length} | ${executor} | attempts ${attempts.length} | verify ${latestVerification?.status ?? "(none)"} | ${task.title}`,
		);
		for (const childId of graph.childIdsByParent.get(taskId) ?? []) {
			append(childId, depth + 1);
		}
	};
	for (const rootTaskId of graph.rootTaskIds) {
		append(rootTaskId, 0);
	}
	return lines;
}

export function formatTaskDetails(
	task: Task,
	attempts: readonly Attempt[],
	verifications: readonly VerificationResult[] = [],
): readonly string[] {
	const lines = [
		`Task ${task.id} | ${task.status} | ${task.kind} | ${task.accessMode}`,
		`Title: ${task.title}`,
		`Dependencies: ${task.dependencyIds.length > 0 ? task.dependencyIds.join(", ") : "(none)"}`,
		`Executor: ${task.assignment?.executorKind ?? "(unassigned)"}`,
		`Attempts: ${attempts.length}`,
		`Verifications: ${verifications.length}`,
		`Modifications: ${task.modifications.length}`,
	];
	if (task.blockedReason) {
		lines.push(`Blocked: ${task.blockedReason.code} | ${task.blockedReason.message}`);
	}
	for (const attempt of attempts) {
		const owner = attempt.agentId ?? attempt.jobId ?? "(none)";
		lines.push(`  #${attempt.number} ${attempt.id} | ${attempt.status} | ${attempt.executorKind}:${owner}`);
	}
	for (const verification of verifications) {
		lines.push(`  verify ${verification.requirementId} | ${verification.status} | ${verification.summary}`);
	}
	for (const modification of task.modifications) {
		lines.push(
			`  ${modification.operation} ${modification.path} | ${modification.agentId} | ${modification.attemptId}`,
		);
	}
	return lines;
}
