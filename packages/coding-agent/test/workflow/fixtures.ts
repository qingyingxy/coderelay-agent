import type {
	Attempt,
	ResourceUsage,
	Task,
	Workflow,
	WorkflowEventBatch,
	WorkflowEventDraft,
} from "../../src/core/workflow/index.ts";
import { createWorkflowEventBatch, WORKFLOW_SCHEMA_VERSION } from "../../src/core/workflow/index.ts";

export const NOW = "2026-07-26T00:00:00.000Z";
export const ZERO_USAGE: ResourceUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	durationMs: 0,
};

export function createDirectStartBatch(
	workflowId = "workflow-1",
	taskId = "task-1",
	idPrefix = "start",
): WorkflowEventBatch {
	const workflow: Workflow = {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: workflowId,
		status: "received",
		rootTaskId: taskId,
		request: {
			text: "Implement a small change",
			cwd: "C:/repo",
			attachments: [],
		},
		budget: {},
		usage: ZERO_USAGE,
	};
	const task: Task = {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: taskId,
		workflowId,
		kind: "agent",
		accessMode: "writer",
		title: "Root task",
		description: "Execute the request",
		status: "pending",
		dependencyIds: [],
		budget: {},
		usage: ZERO_USAGE,
		attemptIds: [],
		verificationRequirements: [
			{
				id: "agent-complete",
				kind: "manual",
				description: "Agent completed without an unhandled runtime error",
				required: true,
			},
		],
	};
	const events: readonly WorkflowEventDraft[] = [
		{
			eventId: `${idPrefix}-event-1`,
			entityId: workflowId,
			entityRevision: 0,
			eventType: "workflow.created",
			occurredAt: NOW,
			actor: { kind: "controller" },
			payload: { workflow },
		},
		{
			eventId: `${idPrefix}-event-2`,
			entityId: workflowId,
			entityRevision: 1,
			eventType: "workflow.mode_decided",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: `${idPrefix}-event-1`,
			payload: {
				decision: {
					mode: "direct",
					source: "default",
					reason: "M1 defaults to Direct",
					riskLevel: "low",
					decidedAt: NOW,
				},
			},
		},
		{
			eventId: `${idPrefix}-event-3`,
			entityId: taskId,
			entityRevision: 0,
			eventType: "task.created",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: `${idPrefix}-event-2`,
			payload: { task },
		},
		{
			eventId: `${idPrefix}-event-4`,
			entityId: workflowId,
			entityRevision: 2,
			eventType: "workflow.status_changed",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: `${idPrefix}-event-3`,
			payload: {
				fromStatus: "received",
				toStatus: "executing",
				facts: {
					directModeSelected: true,
					rootTaskExists: true,
				},
			},
		},
	];
	return createWorkflowEventBatch({
		batchId: `${idPrefix}-batch`,
		workflowId,
		commandId: `${idPrefix}-command`,
		correlationId: `${idPrefix}-correlation`,
		expectedLastSequence: 0,
		events,
	});
}

export function createTaskReadyBatch(
	workflowId = "workflow-1",
	taskId = "task-1",
	idPrefix = "ready",
): WorkflowEventBatch {
	return createWorkflowEventBatch({
		batchId: `${idPrefix}-batch`,
		workflowId,
		commandId: `${idPrefix}-command`,
		correlationId: `${idPrefix}-correlation`,
		expectedLastSequence: 4,
		events: [
			{
				eventId: `${idPrefix}-event-1`,
				entityId: taskId,
				entityRevision: 1,
				eventType: "task.ready",
				occurredAt: NOW,
				actor: { kind: "controller" },
				payload: {
					fromStatus: "pending",
					toStatus: "ready",
					facts: {
						workflowExecuting: true,
						dependenciesSucceeded: true,
					},
				},
			},
		],
	});
}

export function createAttemptSetupBatch(): WorkflowEventBatch {
	const attempt: Attempt = {
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
	};
	return createWorkflowEventBatch({
		batchId: "attempt-setup-batch",
		workflowId: "workflow-1",
		commandId: "attempt-setup-command",
		correlationId: "runtime-correlation",
		expectedLastSequence: 5,
		events: [
			{
				eventId: "attempt-created-event",
				entityId: "attempt-1",
				entityRevision: 0,
				eventType: "attempt.created",
				occurredAt: NOW,
				actor: { kind: "controller" },
				payload: { attempt },
			},
			{
				eventId: "task-assigned-event",
				entityId: "task-1",
				entityRevision: 2,
				eventType: "task.assigned",
				occurredAt: NOW,
				actor: { kind: "controller" },
				causationId: "attempt-created-event",
				payload: {
					assignment: {
						executorKind: "main_agent",
					},
				},
			},
			{
				eventId: "task-started-event",
				entityId: "task-1",
				entityRevision: 3,
				eventType: "task.started",
				occurredAt: NOW,
				actor: { kind: "controller" },
				causationId: "task-assigned-event",
				payload: {
					fromStatus: "ready",
					toStatus: "running",
					facts: {
						attemptCreated: true,
					},
					attemptId: "attempt-1",
				},
			},
		],
	});
}

export function createAttemptStartedBatch(): WorkflowEventBatch {
	return createWorkflowEventBatch({
		batchId: "attempt-started-batch",
		workflowId: "workflow-1",
		commandId: "attempt-started-command",
		correlationId: "runtime-correlation",
		expectedLastSequence: 8,
		events: [
			{
				eventId: "attempt-started-event",
				entityId: "attempt-1",
				entityRevision: 1,
				eventType: "attempt.started",
				occurredAt: NOW,
				actor: { kind: "controller" },
				payload: {
					fromStatus: "queued",
					toStatus: "running",
					startedAt: NOW,
				},
			},
		],
	});
}

export function createVerificationStartedBatch(): WorkflowEventBatch {
	const runningVerification = {
		id: "verification-1",
		workflowId: "workflow-1",
		taskId: "task-1",
		requirementId: "agent-complete",
		status: "running" as const,
		summary: "Checking final Agent result",
		evidenceRefs: [],
		startedAt: NOW,
	};
	return createWorkflowEventBatch({
		batchId: "verification-started-batch",
		workflowId: "workflow-1",
		commandId: "verification-started-command",
		correlationId: "runtime-correlation",
		expectedLastSequence: 9,
		events: [
			{
				eventId: "attempt-succeeded-event",
				entityId: "attempt-1",
				entityRevision: 2,
				eventType: "attempt.succeeded",
				occurredAt: NOW,
				actor: { kind: "controller" },
				payload: {
					fromStatus: "running",
					toStatus: "succeeded",
					endedAt: NOW,
					usage: ZERO_USAGE,
				},
			},
			{
				eventId: "task-verification-started-event",
				entityId: "task-1",
				entityRevision: 4,
				eventType: "task.verification_started",
				occurredAt: NOW,
				actor: { kind: "controller" },
				causationId: "attempt-succeeded-event",
				payload: {
					fromStatus: "running",
					toStatus: "verifying",
					facts: {
						attemptSucceeded: true,
						hasRequiredVerification: true,
					},
					verificationRequirementIds: ["agent-complete"],
				},
			},
			{
				eventId: "verification-started-event",
				entityId: "verification-1",
				entityRevision: 0,
				eventType: "verification.started",
				occurredAt: NOW,
				actor: { kind: "controller" },
				causationId: "task-verification-started-event",
				payload: {
					result: runningVerification,
				},
			},
		],
	});
}

export function createCompletedBatch(): WorkflowEventBatch {
	return createWorkflowEventBatch({
		batchId: "completed-batch",
		workflowId: "workflow-1",
		commandId: "completed-command",
		correlationId: "runtime-correlation",
		expectedLastSequence: 12,
		events: [
			{
				eventId: "verification-passed-event",
				entityId: "verification-1",
				entityRevision: 1,
				eventType: "verification.passed",
				occurredAt: NOW,
				actor: { kind: "controller" },
				payload: {
					result: {
						id: "verification-1",
						workflowId: "workflow-1",
						taskId: "task-1",
						requirementId: "agent-complete",
						status: "passed",
						summary: "Agent completed successfully",
						evidenceRefs: [],
						startedAt: NOW,
						endedAt: NOW,
					},
				},
			},
			{
				eventId: "task-succeeded-event",
				entityId: "task-1",
				entityRevision: 5,
				eventType: "task.succeeded",
				occurredAt: NOW,
				actor: { kind: "controller" },
				causationId: "verification-passed-event",
				payload: {
					fromStatus: "verifying",
					toStatus: "succeeded",
					facts: {
						attemptSucceeded: true,
						taskResultPresent: true,
						requiredVerificationPassed: true,
					},
					result: {
						summary: "Task completed",
						changedFiles: [],
						verificationIds: ["verification-1"],
						completedAt: NOW,
					},
				},
			},
			{
				eventId: "workflow-verifying-event",
				entityId: "workflow-1",
				entityRevision: 3,
				eventType: "workflow.status_changed",
				occurredAt: NOW,
				actor: { kind: "controller" },
				causationId: "task-succeeded-event",
				payload: {
					fromStatus: "executing",
					toStatus: "verifying",
					facts: {
						allRequiredTasksSucceeded: true,
					},
				},
			},
			{
				eventId: "workflow-completed-event",
				entityId: "workflow-1",
				entityRevision: 4,
				eventType: "workflow.completed",
				occurredAt: NOW,
				actor: { kind: "controller" },
				causationId: "workflow-verifying-event",
				payload: {
					fromStatus: "verifying",
					toStatus: "completed",
					facts: {
						completionGatePassed: true,
					},
					result: {
						status: "completed",
						summary: "Workflow completed",
						completedTaskIds: ["task-1"],
						failedTaskIds: [],
						changedFiles: [],
						verificationIds: ["verification-1"],
						risks: [],
						unfinishedItems: [],
						usage: ZERO_USAGE,
						durationMs: 1,
					},
				},
			},
		],
	});
}
