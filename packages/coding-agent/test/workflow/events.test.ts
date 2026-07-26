import { describe, expect, it } from "vitest";
import type {
	AnyWorkflowEvent,
	Attempt,
	DomainViolation,
	ResourceUsage,
	Task,
	VerificationResult,
	Workflow,
	WorkflowEvent,
	WorkflowEventBatch,
	WorkflowEventDraft,
	WorkflowResult,
} from "../../src/core/workflow/index.ts";
import {
	createWorkflowEventBatch,
	validateWorkflowEvent,
	validateWorkflowEventBatch,
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

function createWorkflow(): Workflow {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: "workflow-1",
		status: "received",
		rootTaskId: "task-1",
		request: {
			text: "Implement a small change",
			cwd: "C:/repo",
			attachments: [],
		},
		budget: {},
		usage: ZERO_USAGE,
	};
}

function createTask(): Task {
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
	};
}

function createAttempt(): Attempt {
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
	};
}

function createWorkflowResult(status: WorkflowResult["status"]): WorkflowResult {
	return {
		status,
		summary: status,
		completedTaskIds: status === "completed" ? ["task-1"] : [],
		failedTaskIds: status === "failed" ? ["task-1"] : [],
		changedFiles: [],
		verificationIds: [],
		risks: [],
		unfinishedItems: [],
		usage: ZERO_USAGE,
		durationMs: 1,
		reason: status === "completed" ? undefined : status,
	};
}

function createDirectStartBatch(): WorkflowEventBatch {
	const drafts: readonly WorkflowEventDraft[] = [
		{
			eventId: "event-1",
			entityId: "workflow-1",
			entityRevision: 0,
			eventType: "workflow.created",
			occurredAt: NOW,
			actor: { kind: "controller" },
			payload: { workflow: createWorkflow() },
		},
		{
			eventId: "event-2",
			entityId: "workflow-1",
			entityRevision: 1,
			eventType: "workflow.mode_decided",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: "event-1",
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
			eventId: "event-3",
			entityId: "task-1",
			entityRevision: 0,
			eventType: "task.created",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: "event-2",
			payload: { task: createTask() },
		},
		{
			eventId: "event-4",
			entityId: "workflow-1",
			entityRevision: 2,
			eventType: "workflow.status_changed",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: "event-3",
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
		batchId: "batch-1",
		workflowId: "workflow-1",
		commandId: "command-1",
		correlationId: "correlation-1",
		expectedLastSequence: 0,
		events: drafts,
	});
}

function replaceEvent(batch: WorkflowEventBatch, index: number, replacement: AnyWorkflowEvent): WorkflowEventBatch {
	return {
		...batch,
		events: batch.events.map((event, eventIndex) => (eventIndex === index ? replacement : event)),
	};
}

describe("createWorkflowEventBatch", () => {
	it("assigns shared envelope fields and continuous sequence numbers", () => {
		const batch = createDirectStartBatch();

		expect(batch.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
		expect(batch.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
		expect(batch.events.map((event) => event.workflowId)).toEqual([
			"workflow-1",
			"workflow-1",
			"workflow-1",
			"workflow-1",
		]);
		expect(batch.events.map((event) => event.commandId)).toEqual([
			"command-1",
			"command-1",
			"command-1",
			"command-1",
		]);
		expect(batch.events.map((event) => event.entityType)).toEqual(["workflow", "workflow", "task", "workflow"]);
	});

	it("starts after the supplied last sequence", () => {
		const original = createDirectStartBatch();
		const batch = createWorkflowEventBatch({
			batchId: "batch-2",
			workflowId: original.workflowId,
			commandId: "command-2",
			correlationId: original.correlationId,
			expectedLastSequence: 9,
			events: [
				{
					eventId: "event-10",
					entityId: "attempt-1",
					entityRevision: 0,
					eventType: "attempt.created",
					occurredAt: NOW,
					actor: { kind: "controller" },
					payload: { attempt: createAttempt() },
				},
			],
		});

		expect(batch.events[0]?.sequence).toBe(10);
		expect(validateWorkflowEventBatch(batch)).toEqual([]);
	});
});

describe("validateWorkflowEvent", () => {
	it("accepts a valid Direct start event batch", () => {
		expect(validateWorkflowEventBatch(createDirectStartBatch())).toEqual([]);
	});

	it("validates status guards stored in event payloads", () => {
		const batch = createDirectStartBatch();
		const statusEvent = batch.events[3] as WorkflowEvent<"workflow.status_changed">;
		const invalidEvent: WorkflowEvent<"workflow.status_changed"> = {
			...statusEvent,
			payload: {
				...statusEvent.payload,
				facts: {},
			},
		};

		expect(codes(validateWorkflowEvent(invalidEvent))).toEqual([
			"workflow.direct_mode_required",
			"workflow.root_task_required",
		]);
	});

	it("requires specialized events for blocked, cancellation, and terminal workflow changes", () => {
		const event = createDirectStartBatch().events[3] as WorkflowEvent<"workflow.status_changed">;
		const invalidEvent: WorkflowEvent<"workflow.status_changed"> = {
			...event,
			payload: {
				fromStatus: "executing",
				toStatus: "failed",
				facts: {
					failureTerminalCondition: true,
					runtimeResourcesStopped: true,
				},
			},
		};

		expect(codes(validateWorkflowEvent(invalidEvent))).toEqual(["event.specialized_event_required"]);
	});

	it("matches attempt event names to their target statuses", () => {
		const batch = createWorkflowEventBatch({
			batchId: "batch-attempt",
			workflowId: "workflow-1",
			commandId: "command-attempt",
			correlationId: "correlation-1",
			expectedLastSequence: 10,
			events: [
				{
					eventId: "event-attempt",
					entityId: "attempt-1",
					entityRevision: 1,
					eventType: "attempt.started",
					occurredAt: NOW,
					actor: { kind: "controller" },
					payload: {
						fromStatus: "queued",
						toStatus: "succeeded",
						startedAt: NOW,
					},
				},
			],
		});

		expect(codes(validateWorkflowEvent(batch.events[0] as AnyWorkflowEvent))).toEqual([
			"event.target_status_mismatch",
		]);
	});

	it("rejects mismatched creation envelopes", () => {
		const event = createDirectStartBatch().events[0] as WorkflowEvent<"workflow.created">;
		const invalidEvent: WorkflowEvent<"workflow.created"> = {
			...event,
			entityRevision: 1,
		};

		expect(codes(validateWorkflowEvent(invalidEvent))).toEqual([
			"event.invalid_creation_revision",
			"event.created_entity_mismatch",
		]);
	});

	it("requires actor ids for agent and job events", () => {
		const event = createDirectStartBatch().events[3] as WorkflowEvent<"workflow.status_changed">;
		const invalidEvent: WorkflowEvent<"workflow.status_changed"> = {
			...event,
			actor: { kind: "agent" },
		};

		expect(codes(validateWorkflowEvent(invalidEvent))).toContain("event.actor_id_required");
	});

	it("rejects self-causation", () => {
		const event = createDirectStartBatch().events[3] as WorkflowEvent<"workflow.status_changed">;
		const invalidEvent: WorkflowEvent<"workflow.status_changed"> = {
			...event,
			causationId: event.eventId,
		};

		expect(codes(validateWorkflowEvent(invalidEvent))).toContain("event.self_causation");
	});

	it("matches terminal event and result statuses", () => {
		const batch = createWorkflowEventBatch({
			batchId: "batch-completed",
			workflowId: "workflow-1",
			commandId: "command-completed",
			correlationId: "correlation-1",
			expectedLastSequence: 20,
			events: [
				{
					eventId: "event-completed",
					entityId: "workflow-1",
					entityRevision: 3,
					eventType: "workflow.completed",
					occurredAt: NOW,
					actor: { kind: "controller" },
					payload: {
						fromStatus: "verifying",
						toStatus: "completed",
						facts: { completionGatePassed: true },
						result: createWorkflowResult("failed"),
					},
				},
			],
		});

		expect(codes(validateWorkflowEvent(batch.events[0] as AnyWorkflowEvent))).toContain(
			"event.result_status_mismatch",
		);
	});

	it("matches verification event and result statuses", () => {
		const result: VerificationResult = {
			id: "verification-1",
			workflowId: "workflow-1",
			taskId: "task-1",
			requirementId: "requirement-1",
			status: "failed",
			summary: "failed",
			evidenceRefs: [],
			startedAt: NOW,
			endedAt: NOW,
		};
		const batch = createWorkflowEventBatch({
			batchId: "batch-verification",
			workflowId: "workflow-1",
			commandId: "command-verification",
			correlationId: "correlation-1",
			expectedLastSequence: 21,
			events: [
				{
					eventId: "event-verification",
					entityId: "verification-1",
					entityRevision: 0,
					eventType: "verification.passed",
					occurredAt: NOW,
					actor: { kind: "controller" },
					payload: { result },
				},
			],
		});

		expect(codes(validateWorkflowEvent(batch.events[0] as AnyWorkflowEvent))).toEqual([
			"event.verification_status_mismatch",
		]);
	});
});

describe("validateWorkflowEventBatch", () => {
	it("rejects empty batches", () => {
		const batch = createWorkflowEventBatch({
			batchId: "empty",
			workflowId: "workflow-1",
			commandId: "command-empty",
			correlationId: "correlation-1",
			expectedLastSequence: 0,
			events: [],
		});

		expect(codes(validateWorkflowEventBatch(batch))).toEqual(["batch.events_required"]);
	});

	it("rejects sequence gaps", () => {
		const batch = createDirectStartBatch();
		const event = batch.events[1];
		if (!event) {
			throw new Error("Expected second event");
		}
		const invalidBatch = replaceEvent(batch, 1, { ...event, sequence: 99 } as AnyWorkflowEvent);

		expect(codes(validateWorkflowEventBatch(invalidBatch))).toContain("batch.sequence_gap");
	});

	it("rejects duplicate event ids", () => {
		const batch = createDirectStartBatch();
		const event = batch.events[1];
		if (!event) {
			throw new Error("Expected second event");
		}
		const invalidBatch = replaceEvent(batch, 1, {
			...event,
			eventId: batch.events[0]?.eventId ?? "",
		} as AnyWorkflowEvent);

		expect(codes(validateWorkflowEventBatch(invalidBatch))).toContain("batch.duplicate_event");
	});

	it("rejects workflow, command, and correlation mismatches", () => {
		const batch = createDirectStartBatch();
		const event = batch.events[2];
		if (!event) {
			throw new Error("Expected third event");
		}
		const invalidBatch = replaceEvent(batch, 2, {
			...event,
			workflowId: "workflow-2",
			commandId: "command-2",
			correlationId: "correlation-2",
		} as AnyWorkflowEvent);
		const violations = codes(validateWorkflowEventBatch(invalidBatch));

		expect(violations).toContain("batch.workflow_mismatch");
		expect(violations).toContain("batch.command_mismatch");
		expect(violations).toContain("batch.correlation_mismatch");
	});

	it("requires consecutive revisions for the same entity inside a batch", () => {
		const batch = createDirectStartBatch();
		const event = batch.events[3];
		if (!event) {
			throw new Error("Expected fourth event");
		}
		const invalidBatch = replaceEvent(batch, 3, {
			...event,
			entityRevision: 5,
		} as AnyWorkflowEvent);

		expect(codes(validateWorkflowEventBatch(invalidBatch))).toContain("batch.entity_revision_gap");
	});

	it("rejects causation links to later events in the same batch", () => {
		const batch = createDirectStartBatch();
		const event = batch.events[0];
		if (!event) {
			throw new Error("Expected first event");
		}
		const invalidBatch = replaceEvent(batch, 0, {
			...event,
			causationId: "event-4",
		} as AnyWorkflowEvent);

		expect(codes(validateWorkflowEventBatch(invalidBatch))).toContain("batch.causation_order");
	});
});
