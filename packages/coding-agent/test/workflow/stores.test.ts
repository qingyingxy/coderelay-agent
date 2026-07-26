import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { PersistedWorkflowEventBatch, WorkflowEvent } from "../../src/core/workflow/index.ts";
import {
	createWorkflowEventBatch,
	SessionWorkflowEventLog,
	WorkflowStore,
	WorkflowStoreError,
} from "../../src/core/workflow/index.ts";
import {
	createAttemptSetupBatch,
	createAttemptStartedBatch,
	createCompletedBatch,
	createDirectStartBatch,
	createTaskReadyBatch,
	createVerificationStartedBatch,
	NOW,
} from "./fixtures.ts";

function createPersistedDirectHistory(): {
	readonly eventLog: SessionWorkflowEventLog;
	readonly persisted: readonly PersistedWorkflowEventBatch[];
} {
	const session = SessionManager.inMemory();
	const eventLog = new SessionWorkflowEventLog(session);
	const persisted = [
		eventLog.append(createDirectStartBatch()),
		eventLog.append(createTaskReadyBatch()),
		eventLog.append(createAttemptSetupBatch()),
		eventLog.append(createAttemptStartedBatch()),
	];
	return { eventLog, persisted };
}

describe("WorkflowStore", () => {
	it("applies a persisted Direct start batch", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const store = new WorkflowStore();

		expect(store.apply(eventLog.append(createDirectStartBatch()))).toBe(true);
		expect(store.getWorkflow("workflow-1")).toMatchObject({
			id: "workflow-1",
			revision: 2,
			status: "executing",
			rootTaskId: "task-1",
			modeDecision: {
				mode: "direct",
			},
		});
		expect(store.getTask("task-1")).toMatchObject({
			revision: 0,
			status: "pending",
		});
		expect(store.getLastSequence("workflow-1")).toBe(4);
	});

	it("projects Task and Attempt lifecycle events", () => {
		const { persisted } = createPersistedDirectHistory();
		const store = new WorkflowStore();
		store.replay(persisted);

		expect(store.getTask("task-1")).toMatchObject({
			revision: 3,
			status: "running",
			currentAttemptId: "attempt-1",
			attemptIds: ["attempt-1"],
			assignment: {
				executorKind: "main_agent",
			},
		});
		expect(store.getAttempt("attempt-1")).toMatchObject({
			revision: 1,
			status: "running",
			startedAt: NOW,
		});
		expect(store.listAttempts("task-1")).toHaveLength(1);
		expect(store.getLastSequence("workflow-1")).toBe(9);
	});

	it("projects verification and successful terminal results", () => {
		const { eventLog, persisted } = createPersistedDirectHistory();
		const store = new WorkflowStore();
		store.replay([
			...persisted,
			eventLog.append(createVerificationStartedBatch()),
			eventLog.append(createCompletedBatch()),
		]);

		expect(store.getAttempt("attempt-1")?.status).toBe("succeeded");
		expect(store.getVerification("verification-1")?.status).toBe("passed");
		expect(store.getTask("task-1")).toMatchObject({
			status: "succeeded",
			result: {
				verificationIds: ["verification-1"],
			},
		});
		expect(store.getWorkflow("workflow-1")).toMatchObject({
			status: "completed",
			result: {
				status: "completed",
				completedTaskIds: ["task-1"],
			},
		});
		expect(store.getLastSequence("workflow-1")).toBe(16);
	});

	it("replays current branch batches into the same projection", () => {
		const { eventLog, persisted } = createPersistedDirectHistory();
		const first = new WorkflowStore();
		const replayed = new WorkflowStore();

		first.replay(persisted);
		replayed.replay(eventLog.read());

		expect(replayed.getWorkflow("workflow-1")).toEqual(first.getWorkflow("workflow-1"));
		expect(replayed.listTasks("workflow-1")).toEqual(first.listTasks("workflow-1"));
		expect(replayed.listAttempts("task-1")).toEqual(first.listAttempts("task-1"));
	});

	it("does not apply the same persisted command twice", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const persisted = eventLog.append(createDirectStartBatch());
		const store = new WorkflowStore();

		expect(store.apply(persisted)).toBe(true);
		expect(store.apply(persisted)).toBe(false);
		expect(store.hasProcessedCommand("workflow-1", "start-command")).toBe(true);
		expect(store.getLastSequence("workflow-1")).toBe(4);
	});

	it("rejects batches that did not come from the Event Log", () => {
		const store = new WorkflowStore();
		const unpersisted = createDirectStartBatch() as unknown as PersistedWorkflowEventBatch;

		expect(() => store.apply(unpersisted)).toThrow(WorkflowStoreError);
		expect(store.getWorkflow("workflow-1")).toBeUndefined();
	});

	it("rejects copied tokens even when they originated from the Event Log", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const persisted = eventLog.append(createDirectStartBatch());
		const copied = { ...persisted } as PersistedWorkflowEventBatch;
		const store = new WorkflowStore();

		expect(() => store.apply(copied)).toThrow(WorkflowStoreError);
		expect(store.getWorkflow("workflow-1")).toBeUndefined();
	});

	it("rejects persisted batches applied out of sequence", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		eventLog.append(createDirectStartBatch());
		const ready = eventLog.append(createTaskReadyBatch());
		const store = new WorkflowStore();

		expect(() => store.apply(ready)).toThrow(WorkflowStoreError);
		expect(store.getTask("task-1")).toBeUndefined();
	});

	it("applies a batch atomically when relationship validation fails", () => {
		const start = createDirectStartBatch();
		const workflowCreated = start.events[0] as WorkflowEvent<"workflow.created">;
		const modeDecided = start.events[1] as WorkflowEvent<"workflow.mode_decided">;
		const incompleteBatch = createWorkflowEventBatch({
			batchId: "incomplete-batch",
			workflowId: "workflow-1",
			commandId: "incomplete-command",
			correlationId: "incomplete-correlation",
			expectedLastSequence: 0,
			events: [
				{
					eventId: workflowCreated.eventId,
					entityId: workflowCreated.entityId,
					entityRevision: workflowCreated.entityRevision,
					eventType: workflowCreated.eventType,
					occurredAt: workflowCreated.occurredAt,
					actor: workflowCreated.actor,
					payload: workflowCreated.payload,
				},
				{
					eventId: modeDecided.eventId,
					entityId: modeDecided.entityId,
					entityRevision: modeDecided.entityRevision,
					eventType: modeDecided.eventType,
					occurredAt: modeDecided.occurredAt,
					actor: modeDecided.actor,
					causationId: modeDecided.causationId,
					payload: modeDecided.payload,
				},
			],
		});
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const store = new WorkflowStore();

		expect(() => store.apply(eventLog.append(incompleteBatch))).toThrow(WorkflowStoreError);
		expect(store.getWorkflow("workflow-1")).toBeUndefined();
		expect(store.getLastSequence("workflow-1")).toBe(0);
	});

	it("returns defensive copies of stored projections", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const store = new WorkflowStore();
		store.apply(eventLog.append(createDirectStartBatch()));
		const task = store.getTask("task-1");
		if (!task) {
			throw new Error("Expected root task");
		}

		(task.dependencyIds as string[]).push("external-mutation");

		expect(store.getTask("task-1")?.dependencyIds).toEqual([]);
	});
});
