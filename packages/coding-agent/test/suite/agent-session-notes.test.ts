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
		expect(windowed.session.systemPrompt).toContain("Default to no Notes write");
		expect(windowed.session.systemPrompt).toContain("Verification not run, remaining files or stages, next action");
		expect(windowed.session.systemPrompt).toContain("never open questions");
		expect(windowed.session.systemPrompt).toContain("keep one compact decision or constraint Note per stable topic");
		expect(windowed.session.systemPrompt).toContain("read the matching Note");
		expect(windowed.session.systemPrompt).toContain(
			"After reading a matching Note, query History only for still-missing exact user wording",
		);
	});

	it("injects only the recent Notes index and reads a selected body on demand", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed", notesHintMaxBytes: 4_000 } },
		});
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote({
			noteId: "constraint",
			category: "constraint",
			title: "Preserve user edits",
			content: "Never overwrite unrelated user changes.",
		});
		harness.sessionManager.upsertMemoryNote({
			noteId: "decision",
			category: "decision",
			title: "Continue the current route",
			content: "Reflect from the wall and continue the current route station.",
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("notes", { action: "read", note_id: "decision" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("continued after reading the relevant note"),
		]);

		await harness.session.prompt("continue after switching context");

		const boundary = harness.sessionManager.getBranch().find((entry) => entry.type === "context_window");
		if (boundary?.type !== "context_window") throw new Error("Expected Context Window Entry");
		expect(boundary.contextSeed.content).toContain('"note_id":"constraint"');
		expect(boundary.contextSeed.content).toContain('"note_id":"decision"');
		expect(boundary.contextSeed.content).not.toContain("Never overwrite unrelated user changes.");
		expect(boundary.contextSeed.content).not.toContain(
			"Reflect from the wall and continue the current route station.",
		);
		expect(boundary.contextSeed.truncated).toBe(false);
		expect(getMessageText(harness.session.messages[0])).toContain('"note_id":"decision"');
		const readResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "notes",
		);
		expect(getMessageText(readResult)).toContain("Reflect from the wall and continue the current route station.");
	});

	it("persists a long Note before a same-batch hard cut and retrieves its body when the seed budget omits it", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed", notesHintMaxBytes: 500 } },
		});
		harnesses.push(harness);
		const body = `Full evidence: ${"完整的复现条件。".repeat(300)}`;
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("notes", {
						action: "upsert",
						note_id: "durable-decision",
						category: "decision",
						title: "Keep the append-only boundary",
						content: body,
					}),
					fauxToolCall("new_context", {}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("notes", { action: "read", note_id: "durable-decision" }), {
				stopReason: "toolUse",
			}),
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
		expect(boundary.contextSeed.content).not.toContain("Full evidence:");
		expect(harness.sessionManager.getMemoryNotes()[0].content).toBe(body);
		const readResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "notes",
		);
		expect(getMessageText(readResult)).toContain(body);
		expect(harness.eventsOfType("notes_changed")).toEqual([
			{ type: "notes_changed", action: "upsert", noteId: "durable-decision" },
		]);
	});

	it("searches and reads an old note absent from the new-window hint through model tools", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed", notesHintMaxBytes: 500 } },
		});
		harnesses.push(harness);
		harness.sessionManager.upsertMemoryNote({
			noteId: "initial",
			category: "discovery",
			title: "Initial reproduction",
			keywords: ["未授权"],
			content: "Expired access token; valid refresh token; second concurrent request returned 401.",
		});
		for (let index = 1; index < 8; index++)
			harness.sessionManager.upsertMemoryNote({
				noteId: `recent-${index}`,
				category: "discovery",
				title: `Checkpoint ${index}`,
				content: "Recent work",
			});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("notes", { action: "search", query: "未授权" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("notes", { action: "read", note_id: "initial" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Retrieved the original reproduction."),
		]);
		await harness.session.prompt("Find the original unauthorized reproduction after switching context.");
		const boundary = harness.sessionManager.getBranch().find((entry) => entry.type === "context_window");
		if (boundary?.type !== "context_window") throw new Error("Expected context window");
		expect(boundary.contextSeed.content).not.toContain("Initial reproduction");
		const results = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "notes",
		);
		expect(results).toHaveLength(2);
		expect(getMessageText(results[0])).toContain('"noteId":"initial"');
		expect(getMessageText(results[1])).toContain("second concurrent request returned 401");
		expect(harness.eventsOfType("notes_changed")).toEqual([]);
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

	it("retains prior source Entry IDs across model revisions and merges new evidence", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		const priorId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Propose a natural completion rule." }],
			timestamp: Date.now(),
		});
		const approvalId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Approve that rule." }],
			timestamp: Date.now(),
		});
		harness.sessionManager.upsertMemoryNote({
			noteId: "cutoff",
			category: "open_question",
			content: "Pending approval: finish naturally.",
			sourceEntryIds: [priorId],
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: "cutoff",
					category: "decision",
					content: "Approved: finish naturally.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: "cutoff",
					category: "decision",
					content: "Approved: finish naturally before selection.",
					source_entry_ids: [approvalId],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Decision preserved."),
		]);

		await harness.session.prompt("Record the approved rule.");
		const versions = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_NOTE_CUSTOM_TYPE);
		expect(versions).toHaveLength(3);
		if (versions[1]?.type !== "custom" || versions[2]?.type !== "custom") throw new Error("Missing Note revisions");
		expect(versions[1].data).toMatchObject({ sourceEntryIds: [priorId] });
		expect(versions[2].data).toMatchObject({ sourceEntryIds: [priorId, approvalId] });
	});
});
