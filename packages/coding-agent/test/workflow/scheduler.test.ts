import { describe, expect, it } from "vitest";
import type { Task, TaskAccessMode, TaskStatus } from "../../src/core/workflow/index.ts";
import {
	deriveTaskReadiness,
	TaskExecutorRegistry,
	TaskScheduler,
	TaskSchedulerError,
	WORKFLOW_SCHEMA_VERSION,
} from "../../src/core/workflow/index.ts";
import { NOW, ZERO_USAGE } from "./fixtures.ts";

function task(
	id: string,
	status: TaskStatus,
	options: {
		accessMode?: TaskAccessMode;
		dependencyIds?: readonly string[];
		kind?: Task["kind"];
	} = {},
): Task {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id,
		workflowId: "workflow-scheduler",
		kind: options.kind ?? "agent",
		accessMode: options.accessMode ?? "read_only",
		title: id,
		description: id,
		status,
		dependencyIds: options.dependencyIds ?? [],
		budget: {},
		usage: ZERO_USAGE,
		attemptIds: [],
		verificationRequirements: [],
	};
}

describe("Task Scheduler", () => {
	it("derives Ready Tasks and blocks dependents of terminal failures", () => {
		const readiness = deriveTaskReadiness([
			task("done", "succeeded"),
			task("failed", "failed"),
			task("ready", "pending", { dependencyIds: ["done"] }),
			task("waiting", "pending", { dependencyIds: ["ready"] }),
			task("blocked", "pending", { dependencyIds: ["done", "failed"] }),
		]);

		expect(readiness.readyTaskIds).toEqual(["ready"]);
		expect(readiness.blockedTasks).toEqual([{ taskId: "blocked", dependencyIds: ["failed"] }]);
	});

	it("runs independent read-only Tasks in parallel", () => {
		const scheduler = new TaskScheduler({ maxConcurrency: 2 });

		expect(scheduler.select([task("read-1", "ready"), task("read-2", "ready"), task("read-3", "ready")])).toEqual([
			{
				workflowId: "workflow-scheduler",
				taskId: "read-1",
				executorKind: "main_agent",
				accessMode: "read_only",
			},
			{
				workflowId: "workflow-scheduler",
				taskId: "read-2",
				executorKind: "main_agent",
				accessMode: "read_only",
			},
		]);
	});

	it("gives Writer Tasks exclusive workspace access", () => {
		const scheduler = new TaskScheduler({ maxConcurrency: 3 });
		const writer = task("writer", "ready", { accessMode: "writer" });
		const reader = task("reader", "ready");

		expect(scheduler.select([writer, reader]).map(({ taskId }) => taskId)).toEqual(["writer"]);
		expect(scheduler.select([task("active-writer", "running", { accessMode: "writer" }), reader])).toEqual([]);
		expect(scheduler.select([task("active-reader", "running"), writer, reader]).map(({ taskId }) => taskId)).toEqual([
			"reader",
		]);
	});

	it("routes command Tasks to Jobs and rejects invalid concurrency", () => {
		const scheduler = new TaskScheduler({ maxConcurrency: 1 });
		expect(scheduler.select([task("command", "ready", { kind: "command" })])[0]?.executorKind).toBe("job");
		expect(() => new TaskScheduler({ maxConcurrency: 0 })).toThrow(TaskSchedulerError);
	});

	it("hands a dispatch to the matching executor", async () => {
		const executed: string[] = [];
		const agentTask = task("agent", "ready");
		const dispatch = new TaskScheduler({ maxConcurrency: 1 }).select([agentTask])[0];
		if (!dispatch) {
			throw new Error("Expected an Agent dispatch");
		}
		const registry = new TaskExecutorRegistry([
			{
				kind: "main_agent",
				canExecute: ({ kind }) => kind === "agent",
				execute: async ({ task: selectedTask }) => {
					executed.push(selectedTask.id);
				},
				cancel: async (taskId) => {
					executed.push(`cancel:${taskId}`);
				},
			},
		]);

		await registry.execute({ dispatch, task: agentTask, attemptId: "attempt-agent" });
		await registry.cancel(dispatch, "stop");

		expect(executed).toEqual(["agent", "cancel:agent"]);
	});
});
