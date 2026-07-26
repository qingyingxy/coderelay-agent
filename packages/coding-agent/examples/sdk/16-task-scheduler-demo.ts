/**
 * Task Scheduler Demo
 *
 * Demonstrates deterministic DAG readiness, parallel read-only dispatch, and
 * exclusive Writer dispatch without a model or network connection.
 *
 * Run from the repository root:
 *   npm run demo:task-scheduler
 */

import type { Task, TaskAccessMode, TaskStatus } from "@earendil-works/pi-coding-agent";
import {
	deriveTaskReadiness,
	formatTaskTree,
	TaskScheduler,
	WORKFLOW_SCHEMA_VERSION,
} from "@earendil-works/pi-coding-agent";

const now = "2026-07-26T00:00:00.000Z";
const workflowId = "workflow-task-scheduler-demo";

function task(
	id: string,
	title: string,
	status: TaskStatus,
	accessMode: TaskAccessMode,
	dependencyIds: readonly string[] = [],
): Task {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: now,
		updatedAt: now,
		id,
		workflowId,
		parentTaskId: id === "root" ? undefined : "root",
		kind: id === "root" ? "control" : "agent",
		accessMode,
		title,
		description: title,
		status,
		dependencyIds,
		budget: {},
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0,
			turns: 0,
			durationMs: 0,
		},
		attemptIds: [],
		verificationRequirements: [],
		modifications: [],
	};
}

let tasks: readonly Task[] = [
	task("root", "Task Scheduler demo", "pending", "read_only"),
	task("inspect-api", "Inspect Agent API", "pending", "read_only"),
	task("inspect-cli", "Inspect CLI integration", "pending", "read_only"),
	task("implement", "Implement the change", "pending", "writer", ["inspect-api", "inspect-cli"]),
];
const scheduler = new TaskScheduler({ maxConcurrency: 2 });
const initialReadiness = deriveTaskReadiness(tasks);
tasks = tasks.map((candidate) =>
	initialReadiness.readyTaskIds.includes(candidate.id) ? { ...candidate, status: "ready" } : candidate,
);
const readDispatches = scheduler.select(tasks);
if (readDispatches.length !== 2 || readDispatches.some(({ accessMode }) => accessMode !== "read_only")) {
	throw new Error("Expected two parallel read-only dispatches");
}

tasks = tasks.map((candidate) =>
	readDispatches.some(({ taskId }) => taskId === candidate.id) ? { ...candidate, status: "succeeded" } : candidate,
);
const writerReadiness = deriveTaskReadiness(tasks);
tasks = tasks.map((candidate) =>
	writerReadiness.readyTaskIds.includes(candidate.id) ? { ...candidate, status: "ready" } : candidate,
);
const writerDispatches = scheduler.select(tasks);
if (writerDispatches.length !== 1 || writerDispatches[0]?.taskId !== "implement") {
	throw new Error("Expected the Writer Task after both dependencies succeeded");
}

console.log(formatTaskTree(workflowId, tasks).join("\n"));
console.log(`[parallel] ${readDispatches.map(({ taskId }) => taskId).join(", ")}`);
console.log(`[writer] ${writerDispatches[0].taskId}`);
console.log("[demo] PASS");
