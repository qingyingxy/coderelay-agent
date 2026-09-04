import { describe, expect, it } from "vitest";
import { MEMORY_NOTE_CUSTOM_TYPE, MemoryNoteValidationError } from "../../src/core/notes.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function appendUser(session: SessionManager, text: string): string {
	return session.appendMessage({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
}

describe("SessionManager durable Notes", () => {
	it("replays append-only upsert and archive operations", () => {
		const session = SessionManager.inMemory();
		const sourceEntryId = appendUser(session, "source fact");
		const created = session.upsertMemoryNote(
			{
				noteId: "decision-1",
				category: "decision",
				content: "Use the append-only design",
				sourceEntryIds: [sourceEntryId],
			},
			4_000,
		);
		const updated = session.upsertMemoryNote(
			{
				noteId: "decision-1",
				category: "decision",
				content: "Use the append-only design with branch replay",
				sourceEntryIds: [sourceEntryId],
			},
			4_000,
		);

		expect(session.getMemoryNotes()).toEqual([updated.note]);
		expect(updated.note.createdAt).toBe(created.note.createdAt);
		expect(updated.note.entryId).not.toBe(created.note.entryId);
		const archived = session.archiveMemoryNote("decision-1");

		expect(archived.note.noteId).toBe("decision-1");
		expect(session.getMemoryNotes()).toEqual([]);
		expect(
			session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === MEMORY_NOTE_CUSTOM_TYPE),
		).toHaveLength(3);
	});

	it("isolates Notes by the selected branch and validates source provenance", () => {
		const session = SessionManager.inMemory();
		const rootId = appendUser(session, "root");
		session.upsertMemoryNote(
			{ noteId: "main-note", category: "discovery", content: "main branch", sourceEntryIds: [rootId] },
			4_000,
		);
		const mainLeafId = session.getLeafId();
		session.branch(rootId);
		const siblingSourceId = appendUser(session, "sibling source");
		session.upsertMemoryNote(
			{
				noteId: "sibling-note",
				category: "discovery",
				content: "sibling branch",
				sourceEntryIds: [siblingSourceId],
			},
			4_000,
		);
		expect(session.getMemoryNotes().map(({ noteId }) => noteId)).toEqual(["sibling-note"]);
		if (!mainLeafId) throw new Error("Expected main leaf");
		session.branch(mainLeafId);

		expect(session.getMemoryNotes().map(({ noteId }) => noteId)).toEqual(["main-note"]);
		expect(() =>
			session.upsertMemoryNote(
				{
					noteId: "invalid-source",
					category: "discovery",
					content: "must not cross branches",
					sourceEntryIds: [siblingSourceId],
				},
				4_000,
			),
		).toThrow("is not on the current branch");
	});

	it("rejects malformed persisted Note operations", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(MEMORY_NOTE_CUSTOM_TYPE, {
			schemaVersion: 99,
			noteId: "bad-note",
			operation: "upsert",
			category: "decision",
			content: "bad",
			sourceEntryIds: [],
			createdAt: new Date().toISOString(),
		});

		expect(() => session.getMemoryNotes()).toThrow(MemoryNoteValidationError);
	});

	it("builds a deterministic priority-ordered and byte-bounded hint", () => {
		const session = SessionManager.inMemory();
		session.upsertMemoryNote({ noteId: "discovery", category: "discovery", content: "discovery detail" }, 4_000);
		session.upsertMemoryNote(
			{
				noteId: "workflow-decision",
				category: "decision",
				content: "workflow decision",
				workflowId: "workflow-1",
			},
			4_000,
		);
		session.upsertMemoryNote(
			{ noteId: "constraint", category: "constraint", content: "never overwrite user changes" },
			4_000,
		);
		const hint = session.buildMemoryNotesHint(220, "workflow-1");

		expect(Buffer.byteLength(hint.content, "utf8")).toBeLessThanOrEqual(220);
		expect(hint.content.indexOf("never overwrite user changes")).toBeLessThan(
			hint.content.indexOf("workflow decision"),
		);
		expect(hint.content).toContain("[notes truncated]");
		expect(hint.truncated).toBe(true);
		expect(hint.noteEntryIds.length).toBeGreaterThan(0);
	});

	it("bounds list output and marks omitted Notes", () => {
		const session = SessionManager.inMemory();
		for (let index = 0; index < 8; index++) {
			session.upsertMemoryNote(
				{
					noteId: `note-${index}`,
					category: "discovery",
					content: `detail ${index} ${"x".repeat(100)}`,
				},
				4_000,
			);
		}

		const result = session.listMemoryNotes(1_000);

		expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(1_000);
		expect(result.notes.length).toBeLessThan(8);
		expect(result.truncated).toBe(true);
	});
});
