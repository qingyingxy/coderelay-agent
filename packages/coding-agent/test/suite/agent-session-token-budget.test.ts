import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_WINDOW_WARNING_MESSAGE_TYPE } from "../../src/core/context-management.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const CONTEXT_WINDOW = 100_000;
const RESERVE_TOKENS = 20_000;

describe("AgentSession context window token budget", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("issues one hidden soft warning and gives the model a Notes/new_context turn", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW, maxTokens: 4_000 }],
			settings: { contextManagement: { mode: "windowed", reserveTokens: RESERVE_TOKENS } },
		});
		harnesses.push(harness);
		let warningTurnMessages: readonly string[] = [];
		harness.setResponses([
			fauxAssistantMessage("initial answer"),
			(context) => {
				warningTurnMessages = context.messages.map(getMessageText);
				return fauxAssistantMessage("notes are already current");
			},
			fauxAssistantMessage("later answer"),
		]);

		await harness.session.prompt("x".repeat(240_000));
		await harness.session.prompt("small follow-up");

		const warnings = harness.eventsOfType("context_window_warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ softLimit: 60_000, hardLimit: 80_000 });
		expect(warningTurnMessages.some((text) => text.includes("Save durable cross-window decisions"))).toBe(true);
		expect(harness.session.contextWindowRuntimeState).toMatchObject({
			phase: "notes_collection",
			softWarningIssued: true,
		});
		expect(
			harness.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === CONTEXT_WINDOW_WARNING_MESSAGE_TYPE,
				),
		).toHaveLength(1);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_window")).toBe(false);
	});

	it("forces a hard cut after the threshold response is fully persisted", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW, maxTokens: 4_000 }],
			settings: { contextManagement: { mode: "windowed", reserveTokens: RESERVE_TOKENS } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("threshold answer")]);

		await harness.session.prompt("x".repeat(325_000));

		const branch = harness.sessionManager.getBranch();
		const answerIndex = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
		const boundaryIndex = branch.findIndex((entry) => entry.type === "context_window");
		expect(answerIndex).toBeGreaterThanOrEqual(0);
		expect(boundaryIndex).toBeGreaterThan(answerIndex);
		expect(branch[boundaryIndex]).toMatchObject({ type: "context_window", reason: "threshold" });
		expect(harness.eventsOfType("context_window_warning")).toEqual([]);
		expect(harness.eventsOfType("context_window_end")).toEqual([
			expect.objectContaining({ reason: "threshold", continueAfterCut: false }),
		]);
		expect(harness.session.contextWindowRuntimeState).toMatchObject({
			phase: "idle",
			softWarningIssued: false,
			overflowRecoveryAttempted: false,
		});
		expect(harness.session.messages).toHaveLength(1);
		expect(harness.session.messages[0]).toMatchObject({ role: "custom", customType: "context-window" });
	});

	it("uses summary compaction for plain hybrid chat", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW, maxTokens: 4_000 }],
			settings: {
				compaction: { keepRecentTokens: 1, reserveTokens: RESERVE_TOKENS },
				contextManagement: { mode: "hybrid", reserveTokens: RESERVE_TOKENS },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "hybrid plain-chat summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("threshold answer")]);

		await harness.session.prompt("x".repeat(325_000));

		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_window")).toBe(false);
		expect(harness.eventsOfType("context_window_warning")).toEqual([]);
	});

	it("uses hard cuts for hybrid sessions with an active Workflow provider", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW, maxTokens: 4_000 }],
			settings: {
				compaction: { keepRecentTokens: 1, reserveTokens: RESERVE_TOKENS },
				contextManagement: { mode: "hybrid", reserveTokens: RESERVE_TOKENS },
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([fauxAssistantMessage("threshold answer")]);

		await harness.session.prompt("x".repeat(325_000));

		const boundary = harness.sessionManager.getBranch().find((entry) => entry.type === "context_window");
		expect(boundary).toMatchObject({
			type: "context_window",
			reason: "threshold",
			snapshotEntryId: expect.any(String),
			workflowId: expect.any(String),
		});
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
