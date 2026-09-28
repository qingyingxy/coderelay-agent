import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("bounded pre-cut Notes review", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["manual", "threshold"] as const)("does not make a separate model request for a %s cut", async (reason) => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Analyze the cutoff behavior." }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage("I propose allowing active animations to finish naturally before reveal."),
		);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const tokensBeforeCut = harness.session.getSessionStats().tokens.total;

		const boundary = await harness.session.requestContextWindow(reason);

		expect(boundary?.reason).toBe(reason);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getSessionStats().tokens.total).toBe(tokensBeforeCut);
		expect(harness.eventsOfType("notes_changed")).toEqual([]);
		expect(boundary?.contextSeed.content).not.toContain("Notes pre-cut review incomplete");
	});

	it("uses one bounded review request as an overflow fallback when the recent turn did not update Notes", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		const userId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Analyze the cutoff behavior." }],
			timestamp: Date.now(),
		});
		const replyId = harness.sessionManager.appendMessage(
			fauxAssistantMessage(
				"I propose allowing active animations to finish naturally before reveal; user approval is pending.",
			),
		);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("notes_upsert", {
					note_id: null,
					category: "decision",
					title: "Cutoff proposal pending approval",
					content:
						"Proposed, not approved: let active animations finish naturally before reveal; never accelerate them at cutoff.",
					keywords: ["cutoff"],
					source_entry_ids: [userId, replyId],
				}),
				{ stopReason: "toolUse" },
			),
		]);

		const boundary = await harness.session.requestContextWindow("overflow");

		expect(boundary?.reason).toBe("overflow");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.sessionManager.getMemoryNotes()).toEqual([
			expect.objectContaining({
				title: "Cutoff proposal pending approval",
				sourceEntryIds: [userId, replyId],
			}),
		]);
		expect(boundary?.contextSeed.content).toContain("Cutoff proposal pending approval");
		expect(boundary?.contextSeed.content).not.toContain("let active animations finish naturally");
		expect(harness.eventsOfType("notes_changed")).toHaveLength(1);
	});

	it("skips the overflow review when the recent turn successfully updated a Note", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: "cutoff",
					category: "decision",
					title: "Approved cutoff behavior",
					content: "Approved: active flights finish naturally.",
					source_entry_ids: null,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The approved decision was saved."),
		]);
		await harness.session.prompt("Approve natural completion and save it.");
		const tokensBeforeCut = harness.session.getSessionStats().tokens.total;
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		const boundary = await harness.session.requestContextWindow("overflow");

		expect(boundary?.reason).toBe("overflow");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getSessionStats().tokens.total).toBe(tokensBeforeCut);
		expect(boundary?.contextSeed.content).toContain("Approved cutoff behavior");
		expect(boundary?.contextSeed.content).not.toContain("Approved: active flights finish naturally.");
		expect(harness.eventsOfType("notes_changed")).toEqual([
			{ type: "notes_changed", action: "upsert", noteId: "cutoff" },
		]);
	});

	it("marks a failed overflow review in the seed but still cuts the context", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Keep the old behavior." }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("I will keep the old behavior."));
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" })]);

		const boundary = await harness.session.requestContextWindow("overflow");

		expect(boundary?.contextSeed).toMatchObject({ truncated: true });
		expect(boundary?.contextSeed.content).toContain("Notes pre-cut review incomplete: provider unavailable");
	});
});
