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

	it("queues one hidden soft warning for the next natural model turn", async () => {
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
		expect(harness.faux.state.callCount).toBe(1);
		await harness.session.prompt("small follow-up");
		expect(harness.faux.state.callCount).toBe(2);

		const warnings = harness.eventsOfType("context_window_warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ softLimit: 60_000, hardLimit: 80_000 });
		expect(
			warningTurnMessages.some((text) =>
				text.includes("Upsert only important new or changed cross-window decisions"),
			),
		).toBe(true);
		expect(warningTurnMessages.some((text) => text.includes("do not rescan or summarize the full history"))).toBe(
			true,
		);
		expect(warningTurnMessages.some((text) => text.includes("rewrite unchanged Notes"))).toBe(true);
		expect(warningTurnMessages.some((text) => text.includes("store ordinary progress"))).toBe(true);
		expect(warningTurnMessages.some((text) => text.includes("do not call new_context solely because of it"))).toBe(
			true,
		);
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

	it("does not cut at the soft limit before starting the next Workflow", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW, maxTokens: 4_000 }],
			settings: { contextManagement: { mode: "windowed", reserveTokens: RESERVE_TOKENS } },
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage("first Workflow complete"),
			fauxAssistantMessage("second Workflow complete"),
		]);

		await harness.session.prompt(`first objective ${"x".repeat(240_000)} END-FIRST`);
		await harness.session.prompt("second objective");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("context_window_warning")).toHaveLength(1);
		expect(harness.eventsOfType("context_window_end")).toHaveLength(0);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_window")).toBe(false);
	});

	it("does not cut below the hard limit before starting the next Workflow", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW, maxTokens: 4_000 }],
			settings: { contextManagement: { mode: "windowed", reserveTokens: RESERVE_TOKENS } },
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage("first Workflow complete"),
			(context) => {
				expect(harness.eventsOfType("context_window_end")).toHaveLength(0);
				const combinedContext = context.messages.map(getMessageText).join("\n");
				expect(combinedContext).toContain("first objective");
				expect(combinedContext).toContain("END-FIRST");
				expect(combinedContext).toContain("second objective");
				return fauxAssistantMessage("second Workflow complete");
			},
		]);

		await harness.session.prompt(`first objective ${"x".repeat(290_000)} END-FIRST`);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("context_window_end")).toHaveLength(0);

		await harness.session.prompt("second objective");

		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not tell the model to call new_context at the soft limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW, maxTokens: 4_000 }],
			settings: { contextManagement: { mode: "windowed", reserveTokens: RESERVE_TOKENS } },
			excludedToolNames: ["new_context"],
		});
		harnesses.push(harness);
		let warningTurnMessages: readonly string[] = [];
		harness.setResponses([
			fauxAssistantMessage("initial answer"),
			(context) => {
				warningTurnMessages = context.messages.map(getMessageText);
				return fauxAssistantMessage("continued task work");
			},
		]);

		await harness.session.prompt("x".repeat(240_000));
		await harness.session.prompt("continue implementation");

		expect(harness.session.getActiveToolNames()).not.toContain("new_context");
		expect(
			warningTurnMessages.some((text) =>
				text.includes("This warning is not a context boundary: do not call new_context solely because of it"),
			),
		).toBe(true);
		expect(
			warningTurnMessages.some((text) => text.includes("host will cut automatically after the hard limit")),
		).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
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
