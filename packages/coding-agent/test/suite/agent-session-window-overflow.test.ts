import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession hard-window overflow recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("persists the overflow error, hard-cuts, and retries once from the seed", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
		});
		harnesses.push(harness);
		let retryMessages: readonly { readonly role: string; readonly text: string }[] = [];
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			(context) => {
				retryMessages = context.messages.map((message) => ({
					role: message.role,
					text: getMessageText(message),
				}));
				return fauxAssistantMessage("recovered answer");
			},
		]);

		await harness.session.prompt("recover this objective");

		const branch = harness.sessionManager.getBranch();
		const overflowIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
		);
		const boundaryIndex = branch.findIndex((entry) => entry.type === "context_window");
		expect(overflowIndex).toBeGreaterThanOrEqual(0);
		expect(boundaryIndex).toBeGreaterThan(overflowIndex);
		expect(branch[boundaryIndex]).toMatchObject({
			type: "context_window",
			reason: "overflow",
		});
		expect(retryMessages).toHaveLength(1);
		expect(retryMessages[0]?.role).toBe("user");
		expect(retryMessages[0]?.text).toContain("Current objective: recover this objective");
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("recovered answer");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("context_window_end")).toEqual([
			expect.objectContaining({ reason: "overflow", continueAfterCut: true }),
		]);
		expect(harness.session.contextWindowRuntimeState.overflowRecoveryAttempted).toBe(false);
	});

	it("does not hard-cut or retry a second overflow error", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long again" }),
		]);

		await harness.session.prompt("recover once only");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_window")).toHaveLength(1);
		expect(harness.eventsOfType("context_window_end")).toHaveLength(1);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
		expect(harness.session.contextWindowRuntimeState.overflowRecoveryAttempted).toBe(true);
	});

	it("hard-cuts a successful over-window response without retrying", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 100 }],
			settings: { contextManagement: { mode: "windowed", reserveTokens: 100 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await harness.session.prompt("x".repeat(5_000));

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_window")).toHaveLength(1);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.eventsOfType("context_window_end")).toEqual([
			expect.objectContaining({ reason: "overflow", continueAfterCut: false }),
		]);
	});

	it("keeps summary overflow recovery for hybrid chat without a Workflow", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 1 },
				contextManagement: { mode: "hybrid" },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "hybrid overflow summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("seed answer"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("recovered through summary"),
		]);

		await harness.session.prompt("seed compactable history");
		await harness.session.prompt("plain hybrid chat");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_window")).toBe(false);
	});
});
