import { describe, expect, it } from "vitest";
import { ContextWindowValidationError, validateContextWindowEntry } from "../../src/core/context-management.ts";
import {
	type ContextWindowAppendData,
	type ContextWindowEntry,
	CURRENT_SESSION_VERSION,
	SessionManager,
} from "../../src/core/session-manager.ts";

function createWindowData(overrides: Partial<ContextWindowAppendData> = {}): ContextWindowAppendData {
	return {
		schemaVersion: 1,
		windowId: "window-1",
		firstWindowId: "window-0",
		previousWindowId: "window-0",
		windowIndex: 1,
		reason: "manual",
		contextSeed: {
			schemaVersion: 1,
			content: "Current objective: continue the task.",
			noteEntryIds: [],
			truncated: false,
		},
		tokensBefore: 12_345,
		...overrides,
	};
}

describe("ContextWindowEntry", () => {
	it("uses Session v4 and appends a complete boundary", () => {
		const session = SessionManager.inMemory();
		const messageId = session.appendMessage({ role: "user", content: "old window", timestamp: 1 });
		const windowEntryId = session.appendContextWindow(createWindowData());

		expect(session.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
		const entry = session.getEntry(windowEntryId) as ContextWindowEntry;
		expect(entry).toMatchObject({
			type: "context_window",
			parentId: messageId,
			windowId: "window-1",
			firstWindowId: "window-0",
			previousWindowId: "window-0",
			windowIndex: 1,
			reason: "manual",
			tokensBefore: 12_345,
		});
		expect(validateContextWindowEntry(entry)).toEqual([]);
		expect(session.buildSessionContext().messages).toMatchObject([
			{
				role: "custom",
				customType: "context-window",
				content: expect.stringContaining("Current objective: continue the task."),
			},
		]);
		expect(session.buildSessionContext().messages[0]).toMatchObject({
			content: expect.stringContaining("completedCuts=1"),
		});
	});

	it("persists snapshot and note provenance with the copied seed", () => {
		const session = SessionManager.inMemory();
		const id = session.appendContextWindow(
			createWindowData({
				snapshotEntryId: "snapshot-entry",
				workflowId: "workflow-1",
				contextSeed: {
					schemaVersion: 1,
					content: "Workflow wf-1 is running.",
					workflowSnapshotSequence: 7,
					noteEntryIds: ["note-1"],
					truncated: true,
				},
			}),
		);

		expect(session.getEntry(id)).toMatchObject({
			snapshotEntryId: "snapshot-entry",
			workflowId: "workflow-1",
			contextSeed: {
				workflowSnapshotSequence: 7,
				noteEntryIds: ["note-1"],
				truncated: true,
			},
		});
	});

	it.each([
		["unsupported schema", { schemaVersion: 2 }],
		["empty content", { contextSeed: { schemaVersion: 1, content: "", noteEntryIds: [], truncated: false } }],
		[
			"duplicate note ids",
			{
				contextSeed: {
					schemaVersion: 1,
					content: "seed",
					noteEntryIds: ["note-1", "note-1"],
					truncated: false,
				},
			},
		],
		["invalid first-cut lineage", { previousWindowId: "other-window" }],
		["invalid token count", { tokensBefore: -1 }],
	] as const)("rejects %s", (_name, overrides) => {
		const session = SessionManager.inMemory();

		expect(() =>
			session.appendContextWindow(createWindowData(overrides as unknown as Partial<ContextWindowAppendData>)),
		).toThrow(ContextWindowValidationError);
		expect(session.getEntries()).toEqual([]);
	});
});
