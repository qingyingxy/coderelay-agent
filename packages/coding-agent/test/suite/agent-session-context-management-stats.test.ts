import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession context-management stats and trace", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("separates session totals, active-window estimates, retrieval overhead, Notes, summaries, and hard cuts", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		const session = harness.sessionManager;
		const rootId = session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		session.appendMessage(
			fauxAssistantMessage(fauxToolCall("history", { action: "search", query: "needle" }, { id: "call_1" }), {
				stopReason: "toolUse",
				timestamp: 2,
			}),
		);
		const historyOutput = JSON.stringify({
			schemaVersion: 1,
			action: "search",
			matches: [{ entryId: rootId, snippet: "needle" }],
			truncated: false,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "history",
			content: [{ type: "text", text: historyOutput }],
			isError: false,
			timestamp: 3,
		});
		const note = session.upsertMemoryNote(
			{ noteId: "constraint-1", category: "constraint", content: "Preserve exact behavior" },
			4_000,
		);
		const notesOutput = JSON.stringify({ schemaVersion: 1, action: "upsert", note: note.note });
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "notes",
			content: [{ type: "text", text: notesOutput }],
			isError: false,
			timestamp: 4,
		});
		session.appendCompaction("old summary", rootId, 500, undefined, false, {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		});
		const lineage = session.createNextContextWindowLineage();
		const seed = "current seed with Notes";
		session.appendContextWindow({
			schemaVersion: 1,
			...lineage,
			reason: "manual",
			contextSeed: {
				schemaVersion: 1,
				content: seed,
				noteEntryIds: [note.note.entryId],
				truncated: false,
			},
			tokensBefore: 600,
		});
		session.appendMessage({ role: "user", content: "current request", timestamp: 5 });
		harness.session.agent.state.messages = session.buildSessionContext().messages;

		const stats = harness.session.getSessionStats();
		const trace = harness.session.getContextManagementTrace();

		expect(stats.tokens.total).toBe(100);
		expect(stats.contextManagement).toEqual(trace.stats);
		expect(trace.lineage).toEqual(lineage);
		expect(trace.stats.currentWindow).toMatchObject({
			windowId: lineage.windowId,
			windowIndex: 1,
			entryCount: 1,
			activeMessageCount: 2,
		});
		expect(trace.stats.currentWindow.estimatedTokens).toBeGreaterThan(0);
		expect(trace.stats.hardCuts).toEqual({
			count: 1,
			seedBytes: Buffer.byteLength(seed, "utf8"),
			estimatedSeedTokens: Math.ceil(Buffer.byteLength(seed, "utf8") / 4),
			modelCallTokens: 0,
		});
		expect(trace.stats.history).toEqual({
			queryCount: 1,
			resultBytes: Buffer.byteLength(historyOutput, "utf8"),
			estimatedResultTokens: Math.ceil(Buffer.byteLength(historyOutput, "utf8") / 4),
		});
		expect(trace.historyQueries).toEqual([
			expect.objectContaining({
				action: "search",
				request: { action: "search", query: "needle" },
				resultCount: 1,
				truncated: false,
			}),
		]);
		expect(trace.stats.notes).toEqual({
			operationCount: 1,
			activeCount: 1,
			toolResultCount: 1,
			resultBytes: Buffer.byteLength(notesOutput, "utf8"),
			estimatedResultTokens: Math.ceil(Buffer.byteLength(notesOutput, "utf8") / 4),
		});
		expect(trace.noteOperations).toEqual([
			expect.objectContaining({ noteId: "constraint-1", operation: "upsert", category: "constraint" }),
		]);
		expect(trace.stats.summaries).toEqual({
			count: 1,
			tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
			cost: 1,
		});
	});
});
