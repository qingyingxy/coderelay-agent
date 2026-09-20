import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const unused = {
	title: null,
	keywords: null,
	query: null,
	cursor: null,
	note_id: null,
	category: null,
	content: null,
	workflow_id: null,
	task_id: null,
	source_entry_ids: null,
};

describe("Notes nullable model arguments", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("accepts explicit nulls across all actions without adding filters or changing source state", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		const calls = [
			{ ...unused, action: "upsert", note_id: "n", category: "discovery", content: "401 original evidence" },
			{ ...unused, action: "search", query: "401" },
			{ ...unused, action: "list" },
			{ ...unused, action: "read", note_id: "n" },
			{ ...unused, action: "archive", note_id: "n" },
			{ ...unused, action: "upsert", category: "constraint", content: "Generated ID" },
		];
		harness.setResponses([
			...calls.map((args) => fauxAssistantMessage(fauxToolCall("notes", args), { stopReason: "toolUse" })),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Exercise Notes null arguments");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(6);
		expect(results.every((message) => !message.isError)).toBe(true);
		expect(getMessageText(results[1])).toContain('"noteId":"n"');
		expect(getMessageText(results[2])).toContain('"noteId":"n"');
		expect(getMessageText(results[3])).toContain('"content":"401 original evidence"');
		const active = harness.sessionManager.getMemoryNotes();
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({ content: "Generated ID", keywords: [], sourceEntryIds: [] });
		expect(active[0].noteId).not.toBe("n");
		expect(active[0].workflowId).toBeUndefined();
		expect(active[0].taskId).toBeUndefined();
	});

	it.each([
		[{ ...unused, action: "search" }, "search requires query"],
		[{ ...unused, action: "read" }, "read requires note_id"],
		[{ ...unused, action: "archive" }, "archive requires note_id"],
		[{ ...unused, action: "upsert", content: "body" }, "upsert requires category and content"],
		[{ ...unused, action: "upsert", category: "decision" }, "upsert requires category and content"],
		// Reproduce the real provider's placeholder cursor; nullable support must not silently accept it.
		[
			{ ...unused, action: "search", query: "401", cursor: "x", workflow_id: "x", task_id: "x" },
			"invalid or stale cursor",
		],
		[{ ...unused, action: "read", note_id: "n", cursor: "placeholder" }, "invalid or stale cursor"],
	] as const)("rejects invalid required fields or cursors: %j", async (args, expected) => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote({ noteId: "n", category: "discovery", content: "401 original evidence" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("notes", args), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Validate Notes arguments");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result?.isError).toBe(true);
		expect(getMessageText(result)).toContain(expected);
		expect(harness.sessionManager.getMemoryNotes()).toHaveLength(1);
		expect(harness.eventsOfType("notes_changed")).toEqual([]);
	});

	it("continues an exact read cursor and rejects it after a version update", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed", historyResultMaxBytes: 2400 } },
		});
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote({
			noteId: "n",
			category: "discovery",
			content: `${"中文".repeat(1600)}TAIL`,
		});
		const first = harness.sessionManager.readMemoryNote({ noteId: "n" }, 2400);
		expect(first.nextCursor).toBeDefined();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("notes", { ...unused, action: "read", note_id: "n", cursor: first.nextCursor }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("notes", {
					...unused,
					action: "upsert",
					note_id: "n",
					category: "decision",
					content: "New version",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("notes", { ...unused, action: "read", note_id: "n", cursor: first.nextCursor }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Read and update note");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => Boolean(message.isError))).toEqual([false, false, true]);
		expect(getMessageText(results[2])).toContain("invalid or stale cursor");
	});
});
