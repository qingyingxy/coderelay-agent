import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function createTempDir(): string {
	const directory = join(tmpdir(), `pi-window-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

describe("context window session lifecycle", () => {
	const harnesses: Harness[] = [];
	const tempDirectories: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirectories.length > 0) {
			const directory = tempDirectories.pop();
			if (directory && existsSync(directory)) rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reopens a persisted hard-cut session from its stored seed without rewriting durable state", () => {
		const directory = createTempDir();
		tempDirectories.push(directory);
		const session = SessionManager.create(directory, directory);
		session.appendThinkingLevelChange("high");
		const sourceEntryId = session.appendMessage({ role: "user", content: "old objective", timestamp: 1 });
		session.appendMessage(fauxAssistantMessage("old answer"));
		session.appendModelChange("faux", "model-a");
		const note = session.upsertMemoryNote(
			{
				noteId: "constraint-1",
				category: "constraint",
				content: "Keep the persisted constraint",
				sourceEntryIds: [sourceEntryId],
			},
			4_000,
		);
		const lineage = session.createNextContextWindowLineage();
		session.appendContextWindow({
			schemaVersion: 1,
			...lineage,
			reason: "manual",
			contextSeed: {
				schemaVersion: 1,
				content: "persisted seed",
				noteEntryIds: [note.note.entryId],
				truncated: false,
			},
			tokensBefore: 200,
		});
		session.appendMessage({ role: "user", content: "current request", timestamp: 2 });
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted Session file");
		const contentsBeforeResume = readFileSync(sessionFile, "utf8");

		const resumed = SessionManager.open(sessionFile, directory);
		const context = resumed.buildSessionContext();

		expect(context.messages.map((message) => [message.role, getMessageText(message)])).toEqual([
			["custom", "persisted seed"],
			["user", "current request"],
		]);
		expect(context.model).toEqual({ provider: "faux", modelId: "model-a" });
		expect(context.thinkingLevel).toBe("high");
		expect(resumed.getContextWindowLineage()).toEqual(lineage);
		expect(resumed.getMemoryNotes()).toEqual([expect.objectContaining({ noteId: "constraint-1" })]);
		expect(readFileSync(sessionFile, "utf8")).toBe(contentsBeforeResume);
	});

	it("forks before, at, and after a hard-cut boundary using only the selected branch", () => {
		const directory = createTempDir();
		tempDirectories.push(directory);
		const session = SessionManager.create(directory, directory);
		const oldUserId = session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		const oldAssistantId = session.appendMessage(fauxAssistantMessage("old answer"));
		const lineage = session.createNextContextWindowLineage();
		const boundaryId = session.appendContextWindow({
			schemaVersion: 1,
			...lineage,
			reason: "manual",
			contextSeed: { schemaVersion: 1, content: "fork seed", noteEntryIds: [], truncated: false },
			tokensBefore: 100,
		});
		session.appendMessage({ role: "user", content: "new request", timestamp: 2 });
		const newAssistantId = session.appendMessage(fauxAssistantMessage("new answer"));
		const originalSessionFile = session.getSessionFile();
		if (!originalSessionFile) throw new Error("Expected a persisted Session file");

		const beforeBoundary = SessionManager.open(originalSessionFile, directory);
		beforeBoundary.createBranchedSession(oldAssistantId);
		expect(beforeBoundary.getContextWindowLineage()).toBeNull();
		expect(beforeBoundary.buildSessionContext().messages.map(getMessageText)).toEqual(["old request", "old answer"]);

		const atBoundary = SessionManager.open(originalSessionFile, directory);
		atBoundary.createBranchedSession(boundaryId);
		expect(atBoundary.getContextWindowLineage()).toEqual(lineage);
		expect(atBoundary.buildSessionContext().messages.map(getMessageText)).toEqual(["fork seed"]);

		const afterBoundary = SessionManager.open(originalSessionFile, directory);
		afterBoundary.createBranchedSession(newAssistantId);
		expect(afterBoundary.getContextWindowLineage()).toEqual(lineage);
		expect(afterBoundary.buildSessionContext().messages.map(getMessageText)).toEqual([
			"fork seed",
			"new request",
			"new answer",
		]);

		const sibling = SessionManager.open(originalSessionFile, directory);
		sibling.branch(oldUserId);
		sibling.appendMessage({ role: "user", content: "sibling request", timestamp: 3 });
		expect(sibling.getContextWindowLineage()).toBeNull();
		expect(sibling.buildSessionContext().messages.map(getMessageText)).toEqual(["old request", "sibling request"]);
	});

	it("rebuilds active history and lineage when navigating across a hard-cut boundary", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("old answer"), fauxAssistantMessage("new answer")]);
		await harness.session.prompt("old request");
		const oldAssistantId = harness.sessionManager.getLeafId();
		if (!oldAssistantId) throw new Error("Expected the old Assistant Entry");
		const boundary = await harness.session.requestContextWindow("manual");
		if (!boundary) throw new Error("Expected a Context Window Entry");
		await harness.session.prompt("new request");
		const newAssistantId = harness.sessionManager.getLeafId();
		if (!newAssistantId) throw new Error("Expected the new Assistant Entry");

		await harness.session.navigateTree(oldAssistantId);

		expect(harness.session.messages.map(getMessageText)).toEqual(["old request", "old answer"]);
		expect(harness.sessionManager.getContextWindowLineage()).toBeNull();

		await harness.session.navigateTree(newAssistantId);

		expect(harness.session.messages.map(getMessageText)).toEqual([
			boundary.contextSeed.content,
			"new request",
			"new answer",
		]);
		expect(harness.sessionManager.getContextWindowLineage()).toMatchObject({
			windowId: boundary.windowId,
			windowIndex: 1,
		});
	});

	it("clears soft-warning and failed-window state after a successful rollback", async () => {
		const warningHarness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 4_000 }],
			settings: { contextManagement: { mode: "windowed", reserveTokens: 20_000 } },
		});
		harnesses.push(warningHarness);
		warningHarness.setResponses([fauxAssistantMessage("initial"), fauxAssistantMessage("notes current")]);
		await warningHarness.session.prompt("x".repeat(240_000));
		expect(warningHarness.session.contextWindowRuntimeState).toMatchObject({
			phase: "notes_collection",
			softWarningIssued: true,
		});
		const firstAssistant = warningHarness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("Expected the first Assistant Entry");

		await warningHarness.session.navigateTree(firstAssistant.id);

		expect(warningHarness.session.contextWindowRuntimeState).toEqual({
			phase: "idle",
			reason: undefined,
			requestedAtEntryId: undefined,
			requestedAtTurn: undefined,
			continueAfterCut: false,
			softWarningIssued: false,
			overflowRecoveryAttempted: false,
			error: undefined,
		});

		const failedHarness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(failedHarness);
		failedHarness.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("replacement answer")]);
		await failedHarness.session.prompt("failing branch");
		const userEntry = failedHarness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected the User Entry");
		vi.spyOn(failedHarness.sessionManager, "appendContextWindow").mockImplementationOnce(() => {
			throw new Error("boundary write failed");
		});
		await expect(failedHarness.session.requestContextWindow("manual")).rejects.toThrow("boundary write failed");

		await failedHarness.session.navigateTree(userEntry.id);
		await failedHarness.session.prompt("replacement branch");

		expect(failedHarness.session.contextWindowRuntimeState).toMatchObject({ phase: "idle", error: undefined });
		expect(getMessageText(failedHarness.session.messages.at(-1))).toBe("replacement answer");
	});
});
