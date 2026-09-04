import { describe, expect, it } from "vitest";
import {
	ContextWindowLineageError,
	createNextContextWindowLineage,
	getContextWindowLineage,
	validateContextWindowLineage,
} from "../../src/core/context-management.ts";
import type { ContextWindowEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function windowEntry(
	id: string,
	parentId: string | null,
	windowId: string,
	firstWindowId: string,
	previousWindowId: string,
	windowIndex: number,
): ContextWindowEntry {
	return {
		type: "context_window",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		schemaVersion: 1,
		windowId,
		firstWindowId,
		previousWindowId,
		windowIndex,
		reason: "threshold",
		contextSeed: { schemaVersion: 1, content: `seed ${windowIndex}`, noteEntryIds: [], truncated: false },
		tokensBefore: 1000,
	};
}

function idFactory(...ids: string[]): () => string {
	let index = 0;
	return () => ids[index++] ?? "duplicate";
}

describe("context window lineage", () => {
	it("creates an implicit initial ID and first persisted boundary", () => {
		const lineage = createNextContextWindowLineage([], idFactory("initial", "current"));

		expect(lineage).toEqual({
			windowId: "current",
			firstWindowId: "initial",
			previousWindowId: "initial",
			windowIndex: 1,
		});
	});

	it("derives and advances lineage from the current branch", () => {
		const entries: SessionEntry[] = [
			windowEntry("entry-1", null, "window-1", "initial", "initial", 1),
			windowEntry("entry-2", "entry-1", "window-2", "initial", "window-1", 2),
		];

		expect(getContextWindowLineage(entries)).toEqual({
			windowId: "window-2",
			firstWindowId: "initial",
			previousWindowId: "window-1",
			windowIndex: 2,
		});
		expect(createNextContextWindowLineage(entries, idFactory("window-3"))).toEqual({
			windowId: "window-3",
			firstWindowId: "initial",
			previousWindowId: "window-2",
			windowIndex: 3,
		});
	});

	it.each([
		["index gap", windowEntry("entry-2", "entry-1", "window-2", "initial", "window-1", 3)],
		["changed first id", windowEntry("entry-2", "entry-1", "window-2", "other", "window-1", 2)],
		["wrong previous id", windowEntry("entry-2", "entry-1", "window-2", "initial", "other", 2)],
		["duplicate window id", windowEntry("entry-2", "entry-1", "window-1", "initial", "window-1", 2)],
	] as const)("rejects %s", (_name, second) => {
		const entries: SessionEntry[] = [windowEntry("entry-1", null, "window-1", "initial", "initial", 1), second];

		expect(validateContextWindowLineage(entries)).not.toEqual([]);
		expect(() => getContextWindowLineage(entries)).toThrow(ContextWindowLineageError);
	});

	it("derives lineage independently on sibling branches", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage({ role: "user", content: "root", timestamp: 1 });
		session.appendContextWindow({
			schemaVersion: 1,
			...createNextContextWindowLineage(session.getBranch(), idFactory("initial", "branch-a")),
			reason: "manual",
			contextSeed: { schemaVersion: 1, content: "branch A", noteEntryIds: [], truncated: false },
			tokensBefore: 100,
		});
		session.branch(rootId);

		expect(session.getContextWindowLineage()).toBeNull();
		expect(createNextContextWindowLineage(session.getBranch(), idFactory("branch-b-initial", "branch-b"))).toEqual({
			windowId: "branch-b",
			firstWindowId: "branch-b-initial",
			previousWindowId: "branch-b-initial",
			windowIndex: 1,
		});
	});

	it("rejects a corrupt lineage before rebuilding active context", () => {
		const session = SessionManager.inMemory();
		session.appendContextWindow({
			schemaVersion: 1,
			windowId: "window-2",
			firstWindowId: "initial",
			previousWindowId: "window-1",
			windowIndex: 2,
			reason: "manual",
			contextSeed: { schemaVersion: 1, content: "corrupt", noteEntryIds: [], truncated: false },
			tokensBefore: 100,
		});

		expect(() => session.buildSessionContext()).toThrow(ContextWindowLineageError);
	});
});
