import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { AnyWorkflowEvent, DomainViolation, WorkflowEventBatch } from "../../src/core/workflow/index.ts";
import {
	isPersistedWorkflowEventBatch,
	SessionWorkflowEventLog,
	WORKFLOW_EVENT_BATCH_CUSTOM_TYPE,
	WorkflowEventLogError,
} from "../../src/core/workflow/index.ts";
import { createDirectStartBatch, createTaskReadyBatch } from "./fixtures.ts";

function errorCodes(error: unknown): string[] {
	return error instanceof WorkflowEventLogError
		? error.violations.map((violation: DomainViolation) => violation.code)
		: [];
}

describe("SessionWorkflowEventLog", () => {
	it("appends and reads batches from the current session branch", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const batch = createDirectStartBatch();

		const persisted = eventLog.append(batch);

		expect(persisted.batch).toEqual(batch);
		expect(eventLog.read()).toEqual([persisted]);
		expect(session.getBranch().at(-1)).toMatchObject({
			id: persisted.sessionEntryId,
			type: "custom",
			customType: WORKFLOW_EVENT_BATCH_CUSTOM_TYPE,
			data: batch,
		});
	});

	it("replays batches after reopening a persisted session", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-workflow-event-log-"));
		try {
			const session = SessionManager.create("C:/repo", sessionDir);
			const eventLog = new SessionWorkflowEventLog(session);
			eventLog.append(createDirectStartBatch());
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: 1,
			});
			const sessionFile = session.getSessionFile();
			if (!sessionFile) {
				throw new Error("Expected persisted session file");
			}

			const reopened = SessionManager.open(sessionFile, sessionDir);

			expect(new SessionWorkflowEventLog(reopened).read().map(({ batch }) => batch.batchId)).toEqual([
				"start-batch",
			]);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("returns the first persisted batch for a duplicate command", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const batch = createDirectStartBatch();

		const first = eventLog.append(batch);
		const duplicate = eventLog.append({
			...batch,
			batchId: "different-batch-id",
		});

		expect(duplicate).toEqual(first);
		expect(
			session
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === WORKFLOW_EVENT_BATCH_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("stores and returns defensive batch copies", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const batch = createDirectStartBatch();
		const persisted = eventLog.append(batch);

		(batch.events as AnyWorkflowEvent[]).pop();

		expect(persisted.batch.events).toHaveLength(4);
		expect(eventLog.read()[0]?.batch.events).toHaveLength(4);
		expect(Object.isFrozen(persisted.batch.events)).toBe(true);
	});

	it("brands only Event Log results as persisted batches", () => {
		const eventLog = new SessionWorkflowEventLog(SessionManager.inMemory());
		const batch = createDirectStartBatch();
		const persisted = eventLog.append(batch);

		expect(isPersistedWorkflowEventBatch(persisted)).toBe(true);
		expect(isPersistedWorkflowEventBatch({ ...persisted })).toBe(false);
		expect(isPersistedWorkflowEventBatch(structuredClone(persisted.batch))).toBe(false);
	});

	it("uses only the selected branch when rebuilding history", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendCustomEntry("root");
		const eventLog = new SessionWorkflowEventLog(session);
		const firstBranchBatch = createDirectStartBatch("workflow-1", "task-1", "branch-a");
		const firstBranchEntry = eventLog.append(firstBranchBatch);

		session.branch(rootId);
		const secondBranchBatch = createDirectStartBatch("workflow-2", "task-2", "branch-b");
		const secondBranchEntry = eventLog.append(secondBranchBatch);

		expect(eventLog.read().map(({ batch }) => batch.workflowId)).toEqual(["workflow-2"]);
		expect(session.getEntry(firstBranchEntry.sessionEntryId)).toBeDefined();
		expect(session.getBranch().map((entry) => entry.id)).toContain(secondBranchEntry.sessionEntryId);
		expect(session.getBranch().map((entry) => entry.id)).not.toContain(firstBranchEntry.sessionEntryId);
	});

	it("filters batches by workflow after validating the whole branch", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		eventLog.append(createDirectStartBatch("workflow-1", "task-1", "workflow-a"));
		eventLog.append(createDirectStartBatch("workflow-2", "task-2", "workflow-b"));

		expect(eventLog.read("workflow-2").map(({ batch }) => batch.workflowId)).toEqual(["workflow-2"]);
	});

	it("rejects a sequence conflict against current history", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		eventLog.append(createDirectStartBatch());
		const ready = createTaskReadyBatch();
		const conflicting: WorkflowEventBatch = {
			...ready,
			expectedLastSequence: 3,
			events: ready.events.map((event) => ({ ...event, sequence: 4 })),
		};

		expect(() => eventLog.append(conflicting)).toThrow(WorkflowEventLogError);
		try {
			eventLog.append(conflicting);
		} catch (error) {
			expect(errorCodes(error)).toContain("event_log.sequence_conflict");
		}
	});

	it("stops recovery for an unsupported schema", () => {
		const session = SessionManager.inMemory();
		const batch = createDirectStartBatch();
		session.appendCustomEntry(WORKFLOW_EVENT_BATCH_CUSTOM_TYPE, {
			...batch,
			schemaVersion: 999,
		});
		const eventLog = new SessionWorkflowEventLog(session);

		expect(() => eventLog.read()).toThrow(WorkflowEventLogError);
		try {
			eventLog.read();
		} catch (error) {
			expect(errorCodes(error)).toContain("batch.unsupported_schema");
		}
	});

	it("stops recovery for a cross-batch entity revision conflict", () => {
		const session = SessionManager.inMemory();
		const start = createDirectStartBatch();
		const ready = createTaskReadyBatch();
		session.appendCustomEntry(WORKFLOW_EVENT_BATCH_CUSTOM_TYPE, start);
		session.appendCustomEntry(WORKFLOW_EVENT_BATCH_CUSTOM_TYPE, {
			...ready,
			events: ready.events.map((event) => ({
				...event,
				entityRevision: 3,
			})),
		});
		const eventLog = new SessionWorkflowEventLog(session);

		expect(() => eventLog.read()).toThrow(WorkflowEventLogError);
		try {
			eventLog.read();
		} catch (error) {
			expect(errorCodes(error)).toContain("event_log.entity_revision_conflict");
		}
	});

	it.each([
		{
			name: "batch id",
			code: "event_log.duplicate_batch",
			change: (start: WorkflowEventBatch, ready: WorkflowEventBatch): WorkflowEventBatch => ({
				...ready,
				batchId: start.batchId,
			}),
		},
		{
			name: "event id",
			code: "event_log.duplicate_event",
			change: (start: WorkflowEventBatch, ready: WorkflowEventBatch): WorkflowEventBatch => ({
				...ready,
				events: ready.events.map((event, index) =>
					index === 0 ? { ...event, eventId: start.events[0].eventId } : event,
				),
			}),
		},
		{
			name: "command id",
			code: "event_log.duplicate_command",
			change: (start: WorkflowEventBatch, ready: WorkflowEventBatch): WorkflowEventBatch => ({
				...ready,
				commandId: start.commandId,
				events: ready.events.map((event) => ({ ...event, commandId: start.commandId })),
			}),
		},
	])("stops recovery for a duplicate $name across batches", ({ code, change }) => {
		const session = SessionManager.inMemory();
		const start = createDirectStartBatch();
		const ready = change(start, createTaskReadyBatch());
		session.appendCustomEntry(WORKFLOW_EVENT_BATCH_CUSTOM_TYPE, start);
		session.appendCustomEntry(WORKFLOW_EVENT_BATCH_CUSTOM_TYPE, ready);
		const eventLog = new SessionWorkflowEventLog(session);

		expect(() => eventLog.read()).toThrow(WorkflowEventLogError);
		try {
			eventLog.read();
		} catch (error) {
			expect(errorCodes(error)).toContain(code);
		}
	});

	it("stops recovery when an entity is updated before its creation event", () => {
		const session = SessionManager.inMemory();
		const ready = createTaskReadyBatch();
		session.appendCustomEntry(WORKFLOW_EVENT_BATCH_CUSTOM_TYPE, {
			...ready,
			expectedLastSequence: 0,
			events: ready.events.map((event) => ({ ...event, sequence: 1 })),
		});
		const eventLog = new SessionWorkflowEventLog(session);

		expect(() => eventLog.read()).toThrow(WorkflowEventLogError);
		try {
			eventLog.read();
		} catch (error) {
			expect(errorCodes(error)).toContain("event_log.missing_entity_creation");
		}
	});

	it("stops recovery for malformed custom entry data", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(WORKFLOW_EVENT_BATCH_CUSTOM_TYPE, { invalid: true });
		const eventLog = new SessionWorkflowEventLog(session);

		expect(() => eventLog.read()).toThrow(WorkflowEventLogError);
		try {
			eventLog.read();
		} catch (error) {
			expect(errorCodes(error)).toEqual(["event_log.invalid_batch_data"]);
		}
	});
});
