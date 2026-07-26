import type { AttemptId, ExecutorKind, Task, TaskAccessMode, TaskId, WorkflowId } from "./types.ts";

export interface TaskDependencyBlock {
	readonly taskId: TaskId;
	readonly dependencyIds: readonly TaskId[];
}

export interface TaskReadiness {
	readonly readyTaskIds: readonly TaskId[];
	readonly blockedTasks: readonly TaskDependencyBlock[];
}

export interface TaskDispatch {
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly executorKind: ExecutorKind;
	readonly accessMode: TaskAccessMode;
}

export interface TaskExecutionRequest {
	readonly dispatch: TaskDispatch;
	readonly task: Task;
	readonly attemptId: AttemptId;
}

export interface TaskExecutor {
	readonly kind: ExecutorKind;
	canExecute(task: Task): boolean;
	execute(request: TaskExecutionRequest): Promise<void>;
	cancel(taskId: TaskId, reason: string): Promise<void>;
}

export interface TaskSchedulerOptions {
	readonly maxConcurrency: number;
}

export class TaskExecutorRegistry {
	readonly #executors: ReadonlyMap<ExecutorKind, TaskExecutor>;

	constructor(executors: readonly TaskExecutor[]) {
		this.#executors = new Map(executors.map((executor) => [executor.kind, executor]));
	}

	async execute(request: TaskExecutionRequest): Promise<void> {
		const executor = this.#executors.get(request.dispatch.executorKind);
		if (!executor) {
			throw new TaskSchedulerError(
				"scheduler.executor_missing",
				`No ${request.dispatch.executorKind} executor is registered`,
			);
		}
		if (!executor.canExecute(request.task)) {
			throw new TaskSchedulerError(
				"scheduler.executor_rejected",
				`${request.dispatch.executorKind} cannot execute Task ${request.task.id}`,
			);
		}
		await executor.execute(request);
	}

	async cancel(dispatch: TaskDispatch, reason: string): Promise<void> {
		const executor = this.#executors.get(dispatch.executorKind);
		if (!executor) {
			throw new TaskSchedulerError(
				"scheduler.executor_missing",
				`No ${dispatch.executorKind} executor is registered`,
			);
		}
		await executor.cancel(dispatch.taskId, reason);
	}
}

export class TaskSchedulerError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "TaskSchedulerError";
		this.code = code;
	}
}

function executorKind(task: Task): ExecutorKind {
	switch (task.kind) {
		case "agent":
		case "repair":
			return "main_agent";
		case "command":
			return "job";
		case "control":
			throw new TaskSchedulerError("scheduler.control_task", `Control Task ${task.id} cannot be dispatched`);
	}
}

export function deriveTaskReadiness(tasks: readonly Task[]): TaskReadiness {
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	const readyTaskIds: TaskId[] = [];
	const blockedTasks: TaskDependencyBlock[] = [];
	for (const task of tasks) {
		if (task.status !== "pending" || task.kind === "control") {
			continue;
		}
		const failedDependencyIds = task.dependencyIds.filter((dependencyId) => {
			const dependency = tasksById.get(dependencyId);
			return (
				dependency === undefined ||
				dependency.status === "failed" ||
				dependency.status === "cancelled" ||
				dependency.status === "skipped"
			);
		});
		if (failedDependencyIds.length > 0) {
			blockedTasks.push({
				taskId: task.id,
				dependencyIds: failedDependencyIds,
			});
			continue;
		}
		if (task.dependencyIds.every((dependencyId) => tasksById.get(dependencyId)?.status === "succeeded")) {
			readyTaskIds.push(task.id);
		}
	}
	return { readyTaskIds, blockedTasks };
}

export class TaskScheduler {
	readonly #maxConcurrency: number;

	constructor(options: TaskSchedulerOptions) {
		if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
			throw new TaskSchedulerError("scheduler.invalid_concurrency", "Scheduler concurrency must be positive");
		}
		this.#maxConcurrency = options.maxConcurrency;
	}

	select(tasks: readonly Task[]): readonly TaskDispatch[] {
		const active = tasks.filter(({ status }) => status === "running" || status === "verifying");
		if (active.some(({ accessMode }) => accessMode === "writer")) {
			return [];
		}
		const availableSlots = Math.max(0, this.#maxConcurrency - active.length);
		if (availableSlots === 0) {
			return [];
		}
		const ready = tasks.filter(({ status, kind }) => status === "ready" && kind !== "control");
		if (ready.length === 0) {
			return [];
		}
		if (active.length > 0) {
			return ready
				.filter(({ accessMode }) => accessMode === "read_only")
				.slice(0, availableSlots)
				.map((task) => ({
					workflowId: task.workflowId,
					taskId: task.id,
					executorKind: executorKind(task),
					accessMode: task.accessMode,
				}));
		}
		const first = ready[0];
		if (!first) {
			return [];
		}
		const selected =
			first.accessMode === "writer"
				? [first]
				: ready.filter(({ accessMode }) => accessMode === "read_only").slice(0, availableSlots);
		return selected.map((task) => ({
			workflowId: task.workflowId,
			taskId: task.id,
			executorKind: executorKind(task),
			accessMode: task.accessMode,
		}));
	}
}
