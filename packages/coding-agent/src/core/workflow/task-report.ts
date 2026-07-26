import { createTaskGraph } from "./task-graph.ts";
import type { Attempt, Task, TaskId, WorkflowId } from "./types.ts";

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

export function formatTaskTree(workflowId: WorkflowId, tasks: readonly Task[]): readonly string[] {
	const graph = createTaskGraph(workflowId, tasks);
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	const lines: string[] = [];
	const append = (taskId: TaskId, depth: number): void => {
		const task = tasksById.get(taskId);
		if (!task) {
			return;
		}
		const executor = task.assignment ? ` → ${task.assignment.executorKind}` : "";
		lines.push(
			`${"  ".repeat(depth)}${STATUS_MARKERS[task.status]} ${task.id} | ${task.status} | ${task.accessMode}${executor} | ${task.title}`,
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

export function formatTaskDetails(task: Task, attempts: readonly Attempt[]): readonly string[] {
	const lines = [
		`Task ${task.id} | ${task.status} | ${task.kind} | ${task.accessMode}`,
		`Title: ${task.title}`,
		`Dependencies: ${task.dependencyIds.length > 0 ? task.dependencyIds.join(", ") : "(none)"}`,
		`Executor: ${task.assignment?.executorKind ?? "(unassigned)"}`,
		`Attempts: ${attempts.length}`,
	];
	if (task.blockedReason) {
		lines.push(`Blocked: ${task.blockedReason.code} | ${task.blockedReason.message}`);
	}
	for (const attempt of attempts) {
		lines.push(`  #${attempt.number} ${attempt.id} | ${attempt.status} | ${attempt.executorKind}`);
	}
	return lines;
}
