import type { DomainViolation } from "./transitions.ts";
import type { Task, TaskId, WorkflowId } from "./types.ts";

export interface TaskGraph {
	readonly workflowId: WorkflowId;
	readonly taskIds: readonly TaskId[];
	readonly rootTaskIds: readonly TaskId[];
	readonly childIdsByParent: ReadonlyMap<TaskId, readonly TaskId[]>;
	readonly dependentIdsByDependency: ReadonlyMap<TaskId, readonly TaskId[]>;
}

function violation(code: string, message: string): DomainViolation {
	return { code, message };
}

function hasCycle(edges: ReadonlyMap<TaskId, readonly TaskId[]>): boolean {
	const visiting = new Set<TaskId>();
	const visited = new Set<TaskId>();
	const visit = (taskId: TaskId): boolean => {
		if (visiting.has(taskId)) {
			return true;
		}
		if (visited.has(taskId)) {
			return false;
		}
		visiting.add(taskId);
		for (const nextId of edges.get(taskId) ?? []) {
			if (edges.has(nextId) && visit(nextId)) {
				return true;
			}
		}
		visiting.delete(taskId);
		visited.add(taskId);
		return false;
	};
	return [...edges.keys()].some(visit);
}

export function validateTaskGraph(tasks: readonly Task[]): readonly DomainViolation[] {
	const violations: DomainViolation[] = [];
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	if (tasksById.size !== tasks.length) {
		violations.push(violation("task_graph.duplicate_task", "Task Graph contains duplicate Task ids"));
	}
	const parentEdges = new Map<TaskId, TaskId[]>();
	const dependencyEdges = new Map<TaskId, TaskId[]>();
	for (const task of tasks) {
		parentEdges.set(task.id, task.parentTaskId ? [task.parentTaskId] : []);
		dependencyEdges.set(task.id, [...task.dependencyIds]);
		if (task.parentTaskId && !tasksById.has(task.parentTaskId)) {
			violations.push(
				violation("task_graph.parent_missing", `Task ${task.id} references missing parent ${task.parentTaskId}`),
			);
		}
		for (const dependencyId of task.dependencyIds) {
			if (!tasksById.has(dependencyId)) {
				violations.push(
					violation(
						"task_graph.dependency_missing",
						`Task ${task.id} references missing dependency ${dependencyId}`,
					),
				);
			}
		}
	}
	if (hasCycle(parentEdges)) {
		violations.push(violation("task_graph.parent_cycle", "Task parent relationships must be acyclic"));
	}
	if (hasCycle(dependencyEdges)) {
		violations.push(violation("task_graph.dependency_cycle", "Task dependencies must be acyclic"));
	}
	return violations;
}

export function createTaskGraph(workflowId: WorkflowId, tasks: readonly Task[]): TaskGraph {
	const workflowTasks = tasks.filter((task) => task.workflowId === workflowId);
	const violations = validateTaskGraph(workflowTasks);
	if (violations.length > 0) {
		throw new Error(violations.map(({ message }) => message).join("; "));
	}
	const childIdsByParent = new Map<TaskId, TaskId[]>();
	const dependentIdsByDependency = new Map<TaskId, TaskId[]>();
	for (const task of workflowTasks) {
		if (task.parentTaskId) {
			const childIds = childIdsByParent.get(task.parentTaskId) ?? [];
			childIds.push(task.id);
			childIdsByParent.set(task.parentTaskId, childIds);
		}
		for (const dependencyId of task.dependencyIds) {
			const dependentIds = dependentIdsByDependency.get(dependencyId) ?? [];
			dependentIds.push(task.id);
			dependentIdsByDependency.set(dependencyId, dependentIds);
		}
	}
	return {
		workflowId,
		taskIds: workflowTasks.map(({ id }) => id),
		rootTaskIds: workflowTasks.filter(({ parentTaskId }) => !parentTaskId).map(({ id }) => id),
		childIdsByParent,
		dependentIdsByDependency,
	};
}
