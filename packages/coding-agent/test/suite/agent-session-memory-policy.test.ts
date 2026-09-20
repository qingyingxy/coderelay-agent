import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// Scripted trajectories verify runtime capabilities, not model retrieval judgment.
describe("On-demand memory trajectories", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("continues from visible information without forcing memory tools", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("The current database is SQLite.")]);
		await harness.session.prompt("The current database is SQLite. Repeat that choice.");
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(getMessageText(harness.session.messages.at(-1))).toContain("SQLite");
	});

	it("cuts without a Notes write and stops after one relevant read without History", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote({
			noteId: "database",
			category: "decision",
			title: "Database choice",
			content: "Use SQLite for local storage.",
		});
		const before = harness.sessionManager.getMemoryNotes();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("notes", { action: "read", note_id: "database", cursor: null }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Use SQLite for local storage."),
		]);
		await harness.session.prompt("Continue after a context cut using the saved database decision.");
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_window")).toHaveLength(1);
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual([
			"new_context",
			"notes",
		]);
		expect(harness.eventsOfType("notes_changed")).toHaveLength(0);
		expect(harness.sessionManager.getMemoryNotes()).toEqual(before);
		const read = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "notes",
		);
		expect(getMessageText(read)).toContain("Use SQLite for local storage.");
	});

	it("preserves existing constraints and source metadata when a full replacement carries them forward", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		const source = harness.sessionManager.appendMessage({
			role: "user",
			content: "Keep offline support.",
			timestamp: 1,
		});
		const oldContent = "Keep offline support. Previous decision: JSON files.";
		harness.sessionManager.upsertMemoryNote({
			noteId: "storage",
			category: "decision",
			title: "Storage",
			keywords: ["offline"],
			content: oldContent,
			sourceEntryIds: [source],
		});
		const newContent = "Keep offline support. SQLite supersedes the previous JSON files decision.";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("notes", { action: "read", note_id: "storage", cursor: null }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: "storage",
					category: "decision",
					title: "Storage",
					keywords: ["offline"],
					content: newContent,
					source_entry_ids: [source],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Updated the decision while preserving offline support."),
		]);
		await harness.session.prompt("Record SQLite as the revised storage decision, retaining existing constraints.");
		expect(harness.sessionManager.getMemoryNotes()[0]).toMatchObject({
			content: newContent,
			title: "Storage",
			keywords: ["offline"],
			sourceEntryIds: [source],
		});
		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.every((message) => !message.isError),
		).toBe(true);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && JSON.stringify(entry.data).includes(oldContent)),
		).toBe(true);
	});
});
