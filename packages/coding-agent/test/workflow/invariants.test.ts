import { describe, expect, it } from "vitest";
import type { Attempt, DomainViolation, ResourceUsage, Task, Workflow } from "../../src/core/workflow/index.ts";
import {
	validateAttempt,
	validateTask,
	validateWorkflow,
	WORKFLOW_SCHEMA_VERSION,
} from "../../src/core/workflow/index.ts";

const NOW = "2026-07-26T00:00:00.000Z";
const ZERO_USAGE: ResourceUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	durationMs: 0,
};

function codes(violations: readonly DomainViolation[]): string[] {
	return violations.map((entry) => entry.code);
}

function createWorkflow(overrides: Partial<Workflow> = {}): Workflow {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: "workflow-1",
		status: "received",
		request: {
			text: "Implement a small change",
			cwd: "C:/repo",
			attachments: [],
		},
		budget: {},
		usage: ZERO_USAGE,
		...overrides,
	};
}

function createTask(overrides: Partial<Task> = {}): Task {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: "task-1",
		workflowId: "workflow-1",
		kind: "agent",
		accessMode: "writer",
		title: "Root task",
		description: "Execute the request",
		status: "pending",
		dependencyIds: [],
		budget: {},
		usage: ZERO_USAGE,
		attemptIds: [],
		verificationRequirements: [],
		modifications: [],
		...overrides,
	};
}

function createAttempt(overrides: Partial<Attempt> = {}): Attempt {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: "attempt-1",
		workflowId: "workflow-1",
		taskId: "task-1",
		number: 1,
		status: "queued",
		executorKind: "main_agent",
		usage: ZERO_USAGE,
		...overrides,
	};
}

describe("workflow invariants", () => {
	it("accepts a newly received workflow", () => {
		expect(validateWorkflow(createWorkflow())).toEqual([]);
	});

	it("requires a root task and mode decision once execution starts", () => {
		expect(codes(validateWorkflow(createWorkflow({ status: "executing" })))).toEqual([
			"workflow.root_task_required",
			"workflow.mode_decision_required",
		]);
	});

	it("requires plan state to reference a current plan and plan mode", () => {
		const workflow = createWorkflow({
			status: "planning",
			rootTaskId: "task-1",
			modeDecision: {
				mode: "direct",
				source: "default",
				reason: "default",
				riskLevel: "low",
				decidedAt: NOW,
			},
		});
		expect(codes(validateWorkflow(workflow))).toEqual(["workflow.plan_required", "workflow.plan_mode_required"]);
	});

	it("requires blocked reasons only while blocked", () => {
		const blockedReason = {
			code: "awaiting_input" as const,
			message: "Need input",
			since: NOW,
			resumeStatus: "executing" as const,
		};
		expect(
			codes(
				validateWorkflow(
					createWorkflow({
						blockedReason,
					}),
				),
			),
		).toEqual(["workflow.unexpected_blocked_reason"]);
		expect(
			codes(
				validateWorkflow(
					createWorkflow({
						status: "blocked",
						rootTaskId: "task-1",
						modeDecision: {
							mode: "direct",
							source: "default",
							reason: "default",
							riskLevel: "low",
							decidedAt: NOW,
						},
					}),
				),
			),
		).toContain("workflow.blocked_reason_required");
	});

	it("requires terminal results to match the workflow status", () => {
		const workflow = createWorkflow({
			status: "completed",
			rootTaskId: "task-1",
			modeDecision: {
				mode: "direct",
				source: "default",
				reason: "default",
				riskLevel: "low",
				decidedAt: NOW,
			},
			result: {
				status: "failed",
				summary: "failed",
				completedTaskIds: [],
				failedTaskIds: ["task-1"],
				changedFiles: [],
				verificationIds: [],
				risks: [],
				unfinishedItems: [],
				usage: ZERO_USAGE,
				durationMs: 1,
				reason: "error",
			},
		});
		expect(codes(validateWorkflow(workflow))).toEqual(["workflow.result_status_mismatch"]);
	});

	it("requires failed and cancelled workflows to explain their terminal state", () => {
		const workflow = createWorkflow({
			status: "failed",
			rootTaskId: "task-1",
			modeDecision: {
				mode: "direct",
				source: "default",
				reason: "default",
				riskLevel: "low",
				decidedAt: NOW,
			},
			result: {
				status: "failed",
				summary: "failed",
				completedTaskIds: [],
				failedTaskIds: ["task-1"],
				changedFiles: [],
				verificationIds: [],
				risks: [],
				unfinishedItems: [],
				usage: ZERO_USAGE,
				durationMs: 1,
			},
		});
		expect(codes(validateWorkflow(workflow))).toEqual(["workflow.terminal_reason_required"]);
	});

	it("rejects invalid workflow budget limits", () => {
		expect(codes(validateWorkflow(createWorkflow({ budget: { maxTurns: 1.5 } })))).toEqual([
			"workflow.invalid_budget",
		]);
	});
});

describe("task invariants", () => {
	it("accepts a valid pending root task", () => {
		expect(validateTask(createTask())).toEqual([]);
	});

	it("rejects cyclic references and duplicate ids", () => {
		const task = createTask({
			parentTaskId: "task-1",
			dependencyIds: ["task-1", "task-2", "task-2"],
			attemptIds: ["attempt-1", "attempt-1"],
		});
		expect(codes(validateTask(task))).toEqual([
			"task.self_parent",
			"task.self_dependency",
			"task.duplicate_dependency",
			"task.duplicate_attempt",
		]);
	});

	it("requires current attempts to be part of attempt history", () => {
		expect(codes(validateTask(createTask({ currentAttemptId: "attempt-1" })))).toEqual([
			"task.current_attempt_missing",
		]);
	});

	it("keeps control tasks unassigned", () => {
		expect(
			codes(
				validateTask(
					createTask({
						kind: "control",
						accessMode: "read_only",
						assignment: {
							executorKind: "main_agent",
						},
					}),
				),
			),
		).toEqual(["task.control_assignment"]);
	});

	it("requires commands only on Command Tasks", () => {
		expect(codes(validateTask(createTask({ kind: "command" })))).toEqual(["task.command_required"]);
		expect(codes(validateTask(createTask({ command: "npm run check" })))).toEqual(["task.unexpected_command"]);
		expect(validateTask(createTask({ kind: "command", command: "npm run check" }))).toEqual([]);
	});

	it("requires exactly succeeded tasks to carry a result", () => {
		expect(codes(validateTask(createTask({ status: "succeeded" })))).toEqual(["task.result_required"]);
		expect(
			codes(
				validateTask(
					createTask({
						result: {
							summary: "done",
							changedFiles: [],
							verificationIds: [],
							completedAt: NOW,
						},
					}),
				),
			),
		).toEqual(["task.unexpected_result"]);
	});
});

describe("attempt invariants", () => {
	it("accepts a queued attempt before it starts", () => {
		expect(validateAttempt(createAttempt())).toEqual([]);
	});

	it("requires start and end timestamps for terminal attempts", () => {
		expect(codes(validateAttempt(createAttempt({ status: "succeeded" })))).toEqual([
			"attempt.start_required",
			"attempt.end_required",
		]);
	});

	it("requires failure details only for failed attempts", () => {
		expect(
			codes(
				validateAttempt(
					createAttempt({
						status: "failed",
						startedAt: NOW,
						endedAt: NOW,
					}),
				),
			),
		).toEqual(["attempt.failure_required"]);
		expect(
			codes(
				validateAttempt(
					createAttempt({
						failure: {
							code: "unexpected",
							message: "Unexpected failure",
							retryable: false,
						},
					}),
				),
			),
		).toEqual(["attempt.unexpected_failure"]);
	});
});
