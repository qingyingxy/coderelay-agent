import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_NOTE_CUSTOM_TYPE } from "../../src/core/notes.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession Notes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is hidden in summary mode and active in windowed and hybrid modes", async () => {
		const summary = await createHarness();
		const windowed = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		const hybrid = await createHarness({ settings: { contextManagement: { mode: "hybrid" } } });
		harnesses.push(summary, windowed, hybrid);

		expect(summary.session.getAllTools().map(({ name }) => name)).not.toContain("notes");
		expect(windowed.session.getActiveToolNames()).toContain("notes");
		expect(hybrid.session.getActiveToolNames()).toContain("notes");
	});

	it("persists a Note before a same-batch hard cut and injects it into the new seed", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("notes", {
						action: "upsert",
						note_id: "durable-decision",
						category: "decision",
						content: "Keep the append-only boundary",
					}),
					fauxToolCall("new_context", {}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("continued after notes cut"),
		]);

		await harness.session.prompt("implement durable notes");

		const branch = harness.sessionManager.getBranch();
		const noteEntryIndex = branch.findIndex(
			(entry) => entry.type === "custom" && entry.customType === MEMORY_NOTE_CUSTOM_TYPE,
		);
		const noteToolResultIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes",
		);
		const boundaryIndex = branch.findIndex((entry) => entry.type === "context_window");
		expect(noteEntryIndex).toBeGreaterThanOrEqual(0);
		expect(noteToolResultIndex).toBeGreaterThan(noteEntryIndex);
		expect(boundaryIndex).toBeGreaterThan(noteToolResultIndex);
		const boundary = branch[boundaryIndex];
		if (boundary?.type !== "context_window") throw new Error("Expected Context Window Entry");
		expect(boundary.contextSeed.noteEntryIds).toEqual([branch[noteEntryIndex]?.id]);
		expect(boundary.contextSeed.content).toContain("Keep the append-only boundary");
		expect(getMessageText(harness.session.messages[0])).toContain("Keep the append-only boundary");
		expect(harness.eventsOfType("notes_changed")).toEqual([
			{ type: "notes_changed", action: "upsert", noteId: "durable-decision" },
		]);
	});

	it("archives a Note through the model tool without rewriting prior operations", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote(
			{ noteId: "obsolete", category: "discovery", content: "obsolete detail" },
			4_000,
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("notes", { action: "archive", note_id: "obsolete" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("archived"),
		]);

		await harness.session.prompt("remove obsolete note");

		expect(harness.sessionManager.getMemoryNotes()).toEqual([]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_NOTE_CUSTOM_TYPE),
		).toHaveLength(2);
		expect(harness.eventsOfType("notes_changed")).toEqual([
			{ type: "notes_changed", action: "archive", noteId: "obsolete" },
		]);
	});
});
