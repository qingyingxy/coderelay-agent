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

	it("builds a recent-first whole-index hint without category priority", () => {
		const session = SessionManager.inMemory();
		session.upsertMemoryNote({ noteId: "older", category: "discovery", content: "older background omitted" }, 4_000);
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
		const hint = session.buildMemoryNotesHint(460);

		expect(Buffer.byteLength(hint.content, "utf8")).toBeLessThanOrEqual(460);
		expect(hint.content.indexOf("never overwrite user changes")).toBeLessThan(
			hint.content.indexOf("workflow decision"),
		);
		expect(hint.content).toContain("[notes truncated]");
		expect(hint.truncated).toBe(true);
		expect(hint.noteEntryIds.length).toBeGreaterThan(0);
	});

	it("finds the earliest of eight notes omitted from the hint, including keyword aliases", () => {
		const session = SessionManager.inMemory();
		const source = appendUser(
			session,
			"expired access token, valid refresh token, two concurrent requests: second returns 401",
		);
		const original = session.upsertMemoryNote({
			noteId: "initial",
			category: "discovery",
			title: "Initial reproduction",
			keywords: ["未授权"],
			content: "Two concurrent requests return 401 when access token expires.",
			sourceEntryIds: [source],
			workflowId: "login",
			taskId: "reproduce",
		});
		for (let index = 1; index < 8; index++)
			session.upsertMemoryNote({
				noteId: `recent-${index}`,
				category: "decision",
				title: `Checkpoint ${index}`,
				content: "Recent work",
			});
		const hint = session.buildMemoryNotesHint(510);
		expect(hint.content).not.toContain("initial");
		expect(hint.truncated).toBe(true);
		for (const query of ["401", "未授权", "INITIAL"]) {
			const found = session.listMemoryNotes(2_000, {
				query,
				workflowId: "login",
				taskId: "reproduce",
				category: "discovery",
			});
			expect(found.action).toBe("search");
			expect(found.notes.map((note) => note.noteId)).toEqual(["initial"]);
		}
		const read = session.readMemoryNote({ noteId: "initial" }, 2_000);
		expect(read.note).toEqual(original.note);
		expect(read.note.sourceEntryIds).toEqual([source]);
		expect(session.buildMemoryNotesHint(510)).toEqual(hint);
	});

	it("stores 32 KiB independently and reads every Unicode character within serialized output budgets", () => {
		const session = SessionManager.inMemory();
		const content = `${'中文😀\\"\n'.repeat(1500)}END`;
		const written = session.upsertMemoryNote({ noteId: "long", category: "discovery", title: "Long note", content });
		expect(Buffer.byteLength(content)).toBeGreaterThan(4_000);
		expect(session.buildMemoryNotesHint(4_000).content).not.toContain("END");
		let cursor: string | undefined;
		let restored = "";
		let pages = 0;
		do {
			const result = session.readMemoryNote({ noteId: "long", cursor }, 1_000);
			expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_000);
			expect(result.note.entryId).toBe(written.note.entryId);
			expect(result.note.content).not.toContain("\uFFFD");
			expect(result.note.content.length).toBeGreaterThan(0);
			restored += result.note.content;
			cursor = result.nextCursor;
			expect(++pages).toBeLessThan(200);
		} while (cursor);
		expect(restored).toBe(content);
		session.upsertMemoryNote({ category: "decision", content: "x".repeat(32_768) });
		expect(() => session.upsertMemoryNote({ category: "decision", content: "x".repeat(32_769) })).toThrow(
			"32768-byte",
		);
	});

	it("paginates all indexes without duplicates, and rejects stale or mismatched cursors", () => {
		const session = SessionManager.inMemory();
		for (let index = 0; index < 8; index++)
			session.upsertMemoryNote({
				noteId: `n${index}`,
				category: "discovery",
				title: `Note ${index}`,
				content: "401 ".repeat(2000),
			});
		for (const query of [undefined, "401"]) {
			let cursor: string | undefined;
			const ids: string[] = [];
			do {
				const result = session.listMemoryNotes(900, { query, cursor });
				expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(900);
				ids.push(...result.notes.map((note) => note.noteId));
				cursor = result.nextCursor;
				expect(ids.length).toBeLessThanOrEqual(8);
			} while (cursor);
			expect(ids).toEqual(["n7", "n6", "n5", "n4", "n3", "n2", "n1", "n0"]);
		}
		const page = session.listMemoryNotes(900);
		const read = session.readMemoryNote({ noteId: "n0" }, 900);
		expect(page.nextCursor).toBeDefined();
		expect(read.nextCursor).toBeDefined();
		expect(() => session.listMemoryNotes(900, { query: "401", cursor: page.nextCursor })).toThrow("cursor");
		expect(() => session.readMemoryNote({ noteId: "n1", cursor: read.nextCursor }, 900)).toThrow("cursor");
		session.upsertMemoryNote({ noteId: "n0", category: "decision", content: "New conclusion" });
		expect(session.listMemoryNotes(900).notes[0].noteId).toBe("n0");
		expect(() => session.listMemoryNotes(900, { cursor: page.nextCursor })).toThrow("stale cursor");
		expect(() => session.readMemoryNote({ noteId: "n0", cursor: read.nextCursor }, 900)).toThrow("stale cursor");
		expect(session.listMemoryNotes(4_000, { query: "401" }).notes.map((note) => note.noteId)).not.toContain("n0");
	});

	it("keeps archived and sibling notes out of reads and search", () => {
		const session = SessionManager.inMemory();
		const root = appendUser(session, "root");
		session.upsertMemoryNote({ noteId: "old", category: "discovery", content: "401 evidence" });
		session.archiveMemoryNote("old");
		expect(session.listMemoryNotes(1_000, { query: "401" }).notes).toEqual([]);
		expect(() => session.readMemoryNote({ noteId: "old" }, 1_000)).toThrow("active note");
		session.upsertMemoryNote({ noteId: "sibling", category: "discovery", content: "401 evidence" });
		session.branch(root);
		expect(session.listMemoryNotes(1_000, { query: "401" }).notes).toEqual([]);
		expect(() => session.readMemoryNote({ noteId: "sibling" }, 1_000)).toThrow("current branch");
	});

	it("validates metadata and never partially emits an index at tiny hint budgets", () => {
		const session = SessionManager.inMemory();
		expect(() => session.upsertMemoryNote({ category: "constraint", content: "x", title: "中".repeat(54) })).toThrow(
			"160 UTF-8 bytes",
		);
		expect(() => session.upsertMemoryNote({ category: "constraint", content: "x", title: "line\nbreak" })).toThrow(
			"single",
		);
		expect(() =>
			session.upsertMemoryNote({ category: "constraint", content: "x", keywords: ["中".repeat(27)] }),
		).toThrow("80 UTF-8 bytes");
		const note = session.upsertMemoryNote({ noteId: "n", category: "constraint", title: "标题😀", content: "body" });
		for (const budget of [1, 20, 80, 300, 400, 4_000]) {
			const hint = session.buildMemoryNotesHint(budget);
			expect(Buffer.byteLength(hint.content)).toBeLessThanOrEqual(budget);
			if (hint.noteEntryIds.includes(note.note.entryId)) expect(hint.content).toContain('- n [constraint] "标题😀"');
			else expect(hint.content).not.toContain("- n");
		}
		expect(() => session.listMemoryNotes(1_000, { cursor: "bad" })).toThrow("cursor");
		expect(() => session.listMemoryNotes(1_000, { query: " " })).toThrow("query");
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
