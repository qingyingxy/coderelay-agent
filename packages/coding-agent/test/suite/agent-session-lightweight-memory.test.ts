import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLightweightNotesMaintenance } from "../../evals/context-window/notes-maintenance.ts";
import { MemoryReviewCoordinator } from "../../src/core/workflow/memory-review.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Lightweight Notes maintenance", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const h = await createHarness({
			settings: { contextManagement: { mode: "windowed" }, retry: { enabled: false } },
		});
		harnesses.push(h);
		h.session.enableWorkflowTracking("direct");
		const source = h.sessionManager.appendMessage({ role: "user", content: "Keep offline support.", timestamp: 1 });
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		return { h, source };
	}

	it("cuts with zero writes and leaves explicitly created diagnostic work pending", async () => {
		const { h, source } = await setup();
		const review = new MemoryReviewCoordinator(h.sessionManager);
		const reviewId = review.begin([source]);
		const pending = review.pending();
		const dispatch = h.session.agent.streamFunction;
		const tools = h.session.getActiveToolNames();
		h.setResponses([fauxAssistantMessage("Existing records suffice."), fauxAssistantMessage("unused")]);
		const result = await runLightweightNotesMaintenance(h.session, {
			dispatch: (model, context, options) => {
				expect(context.tools?.map((tool) => tool.name).sort()).toEqual(["history", "new_context", "notes"]);
				expect(context.systemPrompt).not.toContain(reviewId);
				expect(context.systemPrompt).not.toContain("Maintenance phase:");
				return dispatch(model, context, options);
			},
		});
		expect(result).toMatchObject({ completed: true, cuts: 1, hostCut: true, notesWrites: 0, dispatchAttempts: 1 });
		expect(result).not.toHaveProperty("memoryReviewComplete");
		expect(review.pending()).toEqual(pending);
		expect(h.sessionManager.getEntry(source)).toBeDefined();
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.agent.streamFunction).toBe(dispatch);
		expect(h.session.getActiveToolNames()).toEqual(tools);
	});

	it("waits for the last Note write, then cuts without an extra provider call or a changing system prefix", async () => {
		const { h, source } = await setup();
		const dispatch = h.session.agent.streamFunction;
		const systems: string[] = [];
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("notes", { action: "list", cursor: null }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("notes", {
					action: "upsert",
					note_id: "offline",
					category: "constraint",
					title: "Offline support",
					content: "Keep offline support.",
					source_entry_ids: [source],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("unused"),
		]);
		const result = await runLightweightNotesMaintenance(h.session, {
			maxResponses: 2,
			dispatch: (model, context, options) => {
				systems.push(context.systemPrompt ?? "");
				return dispatch(model, context, options);
			},
		});
		expect(result).toMatchObject({
			completed: true,
			cuts: 1,
			hostCut: true,
			dispatchAttempts: 2,
			notesWrites: 1,
			responseLimitReached: true,
		});
		expect(new Set(systems).size).toBe(1);
		expect(h.session.agent.state.pendingToolCalls.size).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
		const note = h.sessionManager.getMemoryNotes()[0];
		expect(note).toMatchObject({ content: "Keep offline support.", sourceEntryIds: [source] });
		const boundary = h.sessionManager.getBranch().find((entry) => entry.type === "context_window");
		expect(boundary?.type === "context_window" && boundary.contextSeed.noteEntryIds).toHaveLength(1);
		expect(boundary?.type === "context_window" && boundary.snapshotEntryId).toBeTruthy();
		expect(new MemoryReviewCoordinator(h.sessionManager).pending()).toEqual([]);
	});

	it("accepts an early model cut without adding another cut or provider request", async () => {
		const { h } = await setup();
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unused"),
		]);
		expect(await runLightweightNotesMaintenance(h.session)).toMatchObject({
			completed: true,
			cuts: 1,
			hostCut: false,
			dispatchAttempts: 1,
		});
		expect(h.eventsOfType("context_window_requested")).toHaveLength(1);
		expect(h.getPendingResponseCount()).toBe(1);
	});

	it.each(["Provider unavailable", "Insufficient budget for next request reservation"])(
		"stops without a host cut on %s",
		async (errorMessage) => {
			const { h, source } = await setup();
			const stream = h.session.agent.streamFunction;
			const tools = h.session.getActiveToolNames();
			h.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("unused"),
			]);
			expect(await runLightweightNotesMaintenance(h.session)).toMatchObject({
				completed: false,
				cuts: 0,
				hostCut: false,
				dispatchAttempts: 1,
				error: errorMessage,
			});
			expect(h.sessionManager.getEntry(source)).toBeDefined();
			expect(h.session.agent.streamFunction).toBe(stream);
			expect(h.session.getActiveToolNames()).toEqual(tools);
			expect(h.getPendingResponseCount()).toBe(1);
		},
	);

	it("reports a failed host cut instead of declaring maintenance complete", async () => {
		const { h } = await setup();
		vi.spyOn(h.session, "requestContextWindow").mockRejectedValue(new Error("Snapshot persistence failed"));
		h.setResponses([fauxAssistantMessage("Ready")]);
		expect(await runLightweightNotesMaintenance(h.session)).toMatchObject({
			completed: false,
			cuts: 0,
			hostCut: false,
			error: "Error: Snapshot persistence failed",
		});
	});

	it("aborts at the deadline without cutting or retrying", async () => {
		const { h } = await setup();
		h.setResponses([
			async (_context, options) => {
				const signal = options?.signal;
				if (!signal) throw new Error("Missing abort signal");
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		expect(await runLightweightNotesMaintenance(h.session, { timeoutMs: 100 })).toMatchObject({
			completed: false,
			cuts: 0,
			hostCut: false,
			error: "Maintenance deadline exceeded",
		});
	});
});
