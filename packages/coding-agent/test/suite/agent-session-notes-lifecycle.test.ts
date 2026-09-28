import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_NOTE_CUSTOM_TYPE } from "../../src/core/notes.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Active Note decision lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("revises a pending proposal in place when approved before cutting context", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: "decision-lifecycle",
					category: "decision",
					title: "Pending behavior proposal",
					content: "Pending proposal: preserve the existing behavior; do not shorten it for a quick fix.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Proposed, not yet approved."),
		]);
		await harness.session.prompt("Analyze this behavior and propose a durable fix; do not edit yet.");

		expect(harness.sessionManager.getMemoryNotes()).toEqual([
			expect.objectContaining({
				noteId: "decision-lifecycle",
				content: expect.stringContaining("Pending proposal"),
			}),
		]);

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("notes", {
						action: "upsert",
						note_id: "decision-lifecycle",
						category: "decision",
						title: "Approved behavior constraint",
						content:
							"User-approved constraint: preserve the existing behavior; do not shorten it for a quick fix.",
					}),
					fauxToolCall("new_context", {}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Continued with the approved constraint."),
		]);
		await harness.session.prompt("I approve the proposed behavior. Continue after cutting context.");

		const notes = harness.sessionManager.getMemoryNotes();
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatchObject({
			noteId: "decision-lifecycle",
			content: "User-approved constraint: preserve the existing behavior; do not shorten it for a quick fix.",
		});
		const branch = harness.sessionManager.getBranch();
		expect(
			branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_NOTE_CUSTOM_TYPE),
		).toHaveLength(2);
		const boundary = branch.find((entry) => entry.type === "context_window");
		if (boundary?.type !== "context_window") throw new Error("Expected context window");
		expect(boundary.contextSeed.content).toContain("Approved behavior constraint");
		expect(boundary.contextSeed.content).not.toContain("User-approved constraint: preserve the existing behavior");
		expect(boundary.contextSeed.content).not.toContain("Pending proposal: preserve the existing behavior");
	});

	it("revises two independently approved proposals under their original IDs", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote({
			noteId: "cutoff",
			category: "decision",
			title: "Pending cutoff proposal",
			content: "Pending approval: let active flights finish naturally before reveal.",
		});
		harness.sessionManager.upsertMemoryNote({
			noteId: "seating",
			category: "decision",
			title: "Pending seating proposal",
			content: "Pending approval: keep each viewer on the assigned seating side.",
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("notes", {
						action: "upsert",
						note_id: "cutoff",
						category: "decision",
						title: "Approved cutoff behavior",
						content: "Approved: active flights finish at normal speed before reveal; do not accelerate them.",
					}),
					fauxToolCall("notes", {
						action: "upsert",
						note_id: "seating",
						category: "decision",
						title: "Approved seating behavior",
						content: "Approved: keep each viewer on the assigned side during promotion and rotation.",
					}),
					fauxToolCall("new_context", {}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Continued with both approved rules."),
		]);
		await harness.session.prompt("Both proposals are approved. Continue after cutting context.");

		const notes = harness.sessionManager.getMemoryNotes();
		expect(notes).toHaveLength(2);
		expect(notes.find((note) => note.noteId === "cutoff")?.content).toContain("do not accelerate");
		expect(notes.find((note) => note.noteId === "seating")?.content).toContain("promotion and rotation");
		const boundary = harness.sessionManager.getBranch().find((entry) => entry.type === "context_window");
		if (boundary?.type !== "context_window") throw new Error("Expected context window");
		expect(boundary.contextSeed.content).toContain("Approved cutoff behavior");
		expect(boundary.contextSeed.content).toContain("Approved seating behavior");
		expect(boundary.contextSeed.content).not.toContain("Approved: active flights finish at normal speed");
		expect(boundary.contextSeed.content).not.toContain("Approved: keep each viewer on the assigned side");
		expect(boundary.contextSeed.content).not.toContain("Pending approval:");
	});

	it("rejects a copied decision body and allows a scoped revision on retry", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote({
			noteId: "cutoff",
			category: "decision",
			content: "Pending approval: let active flights finish naturally.",
		});
		harness.sessionManager.upsertMemoryNote({
			noteId: "seating",
			category: "decision",
			content: "Pending approval: keep viewers on their assigned side.",
		});
		const copied = "Approved: finish flights naturally and keep viewers on their assigned side.";
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("notes", { action: "upsert", note_id: "cutoff", category: "decision", content: copied }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("notes", { action: "upsert", note_id: "seating", category: "decision", content: copied }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: "seating",
					category: "decision",
					content: "Approved: keep each viewer on the assigned side during promotion.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Both decisions saved."),
		]);
		await harness.session.prompt("Approve both proposed behaviors.");

		const results = harness.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes",
			);
		expect(results).toHaveLength(3);
		expect(JSON.stringify(results[1])).toContain("duplicates active note_id cutoff");
		expect(harness.sessionManager.getMemoryNotes()).toEqual([
			expect.objectContaining({ noteId: "cutoff", content: copied }),
			expect.objectContaining({
				noteId: "seating",
				content: "Approved: keep each viewer on the assigned side during promotion.",
			}),
		]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_NOTE_CUSTOM_TYPE),
		).toHaveLength(4);
	});

	it("rejects a new ID for an identical decision in the same scope", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote({
			noteId: "original",
			category: "decision",
			content: "Approved: preserve the original animation speed.",
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: "duplicate",
					category: "decision",
					content: "Approved: preserve the original animation speed.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The original note already covers that decision."),
		]);
		await harness.session.prompt("Save the approved decision.");

		const result = harness.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes",
			);
		expect(JSON.stringify(result)).toContain("duplicates active note_id original");
		expect(harness.sessionManager.getMemoryNotes().map((note) => note.noteId)).toEqual(["original"]);
	});

	it("rejects a near-miss UUID before it creates a second decision note", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		const originalId = "53e630de-ea13-4eec-83f3-d93be39fa8e4";
		const mistypedId = "53e630de-ea13-4ec9-83f3-d93be39fa8e4";
		harness.sessionManager.upsertMemoryNote({
			noteId: originalId,
			category: "open_question",
			content: "Pending approval: allow active flights to finish naturally.",
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: mistypedId,
					category: "decision",
					content: "Approved: let active flights finish naturally before selection.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: originalId,
					category: "decision",
					content: "Approved: let active flights finish naturally before selection.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Recorded under the original ID."),
		]);
		await harness.session.prompt("Approve the flight completion proposal.");

		const results = harness.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notes",
			);
		expect(results).toHaveLength(2);
		expect(JSON.stringify(results[0])).toContain(`closely matches active note_id ${originalId}`);
		expect(harness.sessionManager.getMemoryNotes()).toEqual([
			expect.objectContaining({
				noteId: originalId,
				category: "decision",
				content: "Approved: let active flights finish naturally before selection.",
			}),
		]);
	});
});
