import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

function appendUser(session: SessionManager, text: string): string {
	return session.appendMessage({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
}

function appendWindow(session: SessionManager): string {
	return session.appendContextWindow({
		schemaVersion: 1,
		...session.createNextContextWindowLineage(),
		reason: "manual",
		contextSeed: {
			schemaVersion: 1,
			content: "continuity seed",
			noteEntryIds: [],
			truncated: false,
		},
		tokensBefore: 100,
	});
}

describe("SessionManager history queries", () => {
	it("lists persisted windows and their current-branch ranges", () => {
		const session = SessionManager.inMemory();
		const firstUserId = appendUser(session, "first objective");
		session.appendMessage(fauxAssistantMessage("first answer"));
		const firstBoundaryId = appendWindow(session);
		const secondUserId = appendUser(session, "second objective");
		appendWindow(session);
		const thirdUserId = appendUser(session, "third objective");

		const result = session.queryHistory({ action: "list" }, 16_000);

		expect(result.action).toBe("list");
		if (result.action !== "list") throw new Error("Expected list result");
		expect(result.windows).toHaveLength(3);
		expect(result.windows[0]).toMatchObject({
			windowIndex: 0,
			current: false,
			startEntryId: firstUserId,
			entryCount: 2,
			readableEntryCount: 2,
		});
		expect(result.windows[1]).toMatchObject({
			windowIndex: 1,
			current: false,
			reason: "manual",
			boundaryEntryId: firstBoundaryId,
			startEntryId: secondUserId,
		});
		expect(result.windows[2]).toMatchObject({
			windowIndex: 2,
			current: true,
			startEntryId: thirdUserId,
		});
	});

	it("searches deterministically with role, tool, and window filters without leaking siblings", () => {
		const session = SessionManager.inMemory();
		appendUser(session, "root objective");
		const assistantId = session.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", { path: "src/alpha.ts" }), { stopReason: "toolUse" }),
		);
		const boundaryId = appendWindow(session);
		appendUser(session, "current branch marker");
		const currentLeafId = session.getLeafId();
		session.branch(assistantId);
		appendUser(session, "sibling-only-secret");
		if (!currentLeafId) throw new Error("Expected current leaf");
		session.branch(currentLeafId);

		const list = session.queryHistory({ action: "list" }, 16_000);
		if (list.action !== "list") throw new Error("Expected list result");
		const initialWindowId = list.windows[0]?.windowId;
		if (!initialWindowId) throw new Error("Expected initial window");
		const match = session.queryHistory(
			{ action: "search", query: "alpha.ts", role: "assistant", tool: "read", windowId: initialWindowId },
			16_000,
		);
		const sibling = session.queryHistory({ action: "search", query: "sibling-only-secret" }, 16_000);

		expect(match).toMatchObject({
			action: "search",
			matches: [{ entryId: assistantId, windowId: initialWindowId, role: "assistant", toolNames: ["read"] }],
		});
		expect(sibling).toMatchObject({ action: "search", matches: [] });
		expect(session.getEntry(boundaryId)?.type).toBe("context_window");
	});

	it("pages through one oversized tool result without exceeding the result budget", () => {
		const session = SessionManager.inMemory();
		const original = "large-result-line\n".repeat(400);
		const entryId = session.appendMessage({
			role: "toolResult",
			toolCallId: "large-call",
			toolName: "bash",
			content: [{ type: "text", text: original }],
			isError: false,
			timestamp: Date.now(),
		});
		let cursor: string | undefined;
		let reconstructed = "";
		let pages = 0;
		const maxBytes = 2_048;

		do {
			const result = session.queryHistory({ action: "read", entryIds: [entryId], cursor, limit: 1 }, maxBytes);
			if (result.action !== "read") throw new Error("Expected read result");
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(maxBytes);
			reconstructed += result.entries[0]?.content ?? "";
			cursor = result.nextCursor;
			pages++;
			if (pages > 100) throw new Error("History pagination did not terminate");
		} while (cursor);

		expect(pages).toBeGreaterThan(1);
		expect(reconstructed).toBe(original);
	});

	it("does not return excluded, sensitive, internal, or recursive History results", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "bashExecution",
			command: "secret command",
			output: "excluded-secret",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: Date.now(),
		});
		session.appendCustomMessageEntry("sensitive-context", "sensitive-secret", true, { sensitive: true });
		session.appendMessage({
			role: "toolResult",
			toolCallId: "history-call",
			toolName: "history",
			content: [{ type: "text", text: "recursive-secret" }],
			isError: false,
			timestamp: Date.now(),
		});
		session.appendCustomEntry("internal-state", { text: "internal-secret" });

		for (const query of ["excluded-secret", "sensitive-secret", "recursive-secret", "internal-secret"]) {
			const result = session.queryHistory({ action: "search", query }, 16_000);
			expect(result).toMatchObject({ action: "search", matches: [] });
		}
	});

	it("reports sibling and non-readable Entry IDs as unavailable", () => {
		const session = SessionManager.inMemory();
		const rootId = appendUser(session, "root");
		const internalId = session.appendCustomEntry("state", { value: 1 });
		const currentLeafId = session.getLeafId();
		session.branch(rootId);
		const siblingId = appendUser(session, "sibling");
		if (!currentLeafId) throw new Error("Expected current leaf");
		session.branch(currentLeafId);

		const result = session.queryHistory(
			{ action: "read", entryIds: [rootId, internalId, siblingId, "missing"] },
			16_000,
		);

		expect(result).toMatchObject({
			action: "read",
			entries: [{ entryId: rootId, content: "root" }],
			unavailableEntryIds: [internalId, siblingId, "missing"],
		});
	});
});
