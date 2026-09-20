import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionWorkflowSnapshotStore } from "../../src/core/workflow/event-log.ts";
import { MemoryReviewCoordinator } from "../../src/core/workflow/memory-review.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Workflow memory revision review", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup(content = "Do not add a delay. Use the next available slot.") {
		const h = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(h);
		const oldId = h.sessionManager.appendMessage({ role: "user", content: "The delay is pending.", timestamp: 1 });
		h.sessionManager.upsertMemoryNote({
			noteId: "delay",
			category: "open_question",
			content: "Delay pending.",
			sourceEntryIds: [oldId],
		});
		const source = h.sessionManager.appendMessage({
			role: "user",
			content,
			timestamp: 2,
		});
		const review = new MemoryReviewCoordinator(h.sessionManager);
		const id = review.begin([source]);
		return { h, source, oldId, review, id };
	}

	it("does not complete a review when a declared revision is missing from its Note sources", async () => {
		const { h, source, review, id } = await setup();
		expect(() =>
			review.submit(id, [{ sourceEntryId: source, outcome: "saved", noteIds: ["delay"], reason: "Revised" }]),
		).toThrow("citing its original");
		expect(review.pending()).toHaveLength(1);
		expect(new SessionWorkflowSnapshotStore(h.sessionManager).readLatest(id)?.tasks[0].status).toBe("running");
		expect(() => review.submit(id, [])).toThrow("every scoped user message");
		try {
			review.submit(id, [{ sourceEntryId: source, outcome: "saved", noteIds: ["delay"], reason: "Revised" }]);
		} catch (error) {
			expect(String(error)).toContain(source);
			expect(String(error)).toContain('"noteIds":["delay"]');
			expect(String(error)).toContain("Do not add a citation without supporting content");
		}
		expect(
			h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "memory-review-evidence"),
		).toHaveLength(0);
	});

	it("reports all broken links and accepts a corrected resubmission", async () => {
		const { h, source, oldId, review, id } = await setup();
		expect(() =>
			review.submit(id, [
				{ sourceEntryId: source, outcome: "saved", noteIds: ["missing", "delay"], reason: "Revised" },
			]),
		).toThrow("missing or archived");
		h.sessionManager.upsertMemoryNote({
			noteId: "delay",
			category: "decision",
			content: "Pending -> no delay; next available slot.",
			sourceEntryIds: [oldId, source],
		});
		expect(
			review.submit(id, [
				{ sourceEntryId: source, outcome: "saved", noteIds: ["delay"], reason: "Revised and cited" },
			]).completed,
		).toBe(true);
	});

	it("completes coverage only after a revision is saved and retains evidence distinct from runtime completion", async () => {
		const { h, source, oldId, review, id } = await setup();
		h.sessionManager.upsertMemoryNote({
			noteId: "delay",
			category: "decision",
			content: "Pending -> no delay; next available slot.",
			sourceEntryIds: [oldId, source],
		});
		expect(
			review.submit(id, [
				{ sourceEntryId: source, outcome: "saved", noteIds: ["delay"], reason: "Replaces pending decision" },
			]).completed,
		).toBe(true);
		const snapshot = new SessionWorkflowSnapshotStore(h.sessionManager).readLatest(id)!;
		expect(snapshot.workflow.status).toBe("completed");
		expect(snapshot.verifications[0].result.requirementId).toBe("memory-revision-coverage");
		expect(snapshot.verifications[0].result.evidenceRefs).toHaveLength(1);
		expect(review.pending()).toHaveLength(0);
	});

	it("allows an unchanged decision to be checked without a Note write", async () => {
		const { h, source, review, id } = await setup("The delay decision is still pending; no change.");
		const notes = h.sessionManager.getMemoryNotes();
		// Scripted unchanged classification tests the route, not semantic model judgment.
		expect(
			review.submit(id, [
				{ sourceEntryId: source, outcome: "unchanged", noteIds: [], reason: "Fixture: no new durable information" },
			]).completed,
		).toBe(true);
		expect(h.sessionManager.getMemoryNotes()).toEqual(notes);
	});

	it("retains deferred work across a real cut and replays it into a later provider request", async () => {
		const { h, source, review, id } = await setup();
		review.submit(id, [
			{ sourceEntryId: source, outcome: "deferred", noteIds: ["delay"], reason: "Need to compare later history" },
		]);
		const inputs: string[] = [];
		const dispatch = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			const projection = new MemoryReviewCoordinator(h.sessionManager).projection();
			inputs.push(projection);
			return dispatch(model, { ...context, systemPrompt: `${context.systemPrompt}\n${projection}` }, options);
		};
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Review remains unresolved."),
		]);
		await h.session.prompt("Cut now and retain unfinished checks.");
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window")).toHaveLength(1);
		const restored = new MemoryReviewCoordinator(h.sessionManager);
		expect(restored.pending()[0].sourceEntryIds).toEqual([source]);
		expect(inputs.at(-1)).toContain(id);
		expect(inputs.at(-1)).toContain("subsequent related History");
		expect(new SessionWorkflowSnapshotStore(h.sessionManager).readLatest(id)?.tasks[0].status).toBe("running");
	});

	it("rejects invented sources and duplicate coverage", async () => {
		const { source, review, id } = await setup();
		expect(() => review.begin(["invented"])).toThrow("current-branch");
		const item = { sourceEntryId: source, outcome: "deferred" as const, noteIds: [], reason: "uncertain" };
		expect(() => review.submit(id, [item, item])).toThrow("exactly once");
	});
});
