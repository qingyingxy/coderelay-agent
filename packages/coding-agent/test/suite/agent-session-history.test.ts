import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession history tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is hidden in summary mode and active in windowed and hybrid modes", async () => {
		const summary = await createHarness();
		const windowed = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		const hybrid = await createHarness({ settings: { contextManagement: { mode: "hybrid" } } });
		harnesses.push(summary, windowed, hybrid);

		expect(summary.session.getAllTools().map(({ name }) => name)).not.toContain("history");
		expect(windowed.session.getActiveToolNames()).toContain("history");
		expect(hybrid.session.getActiveToolNames()).toContain("history");
	});

	it("retrieves an exact old-window answer and emits bounded query metadata", async () => {
		const historyResultMaxBytes = 2_400;
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed", historyResultMaxBytes } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("old-window-needle")]);
		await harness.session.prompt("first objective");
		const oldAnswerEntry = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!oldAnswerEntry) throw new Error("Expected persisted answer");
		await harness.session.requestContextWindow("manual");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("history", { action: "search", query: "old-window-needle" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("retrieved"),
		]);

		await harness.session.prompt("recover the exact earlier answer");

		const resultMessage = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "history",
		);
		const resultText = resultMessage ? getMessageText(resultMessage) : "";
		expect(resultText).toContain(oldAnswerEntry.id);
		expect(resultText).toContain("old-window-needle");
		expect(Buffer.byteLength(resultText, "utf8")).toBeLessThanOrEqual(historyResultMaxBytes);
		expect(harness.eventsOfType("history_query")).toEqual([
			expect.objectContaining({
				action: "search",
				resultCount: 1,
				truncated: false,
			}),
		]);
	});

	it("treats nullable unused arguments from strict tool schemas as absent", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("nullable-history-needle")]);
		await harness.session.prompt("first objective");
		await harness.session.requestContextWindow("manual");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("history", {
					action: "search",
					query: "nullable-history-needle",
					role: null,
					tool: null,
					window_id: null,
					entry_ids: null,
					cursor: null,
					limit: 10,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("retrieved"),
		]);

		await harness.session.prompt("recover the earlier answer");

		const resultMessage = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "history",
		);
		expect(resultMessage ? getMessageText(resultMessage) : "").toContain("nullable-history-needle");
		expect(harness.eventsOfType("history_query")).toEqual([
			expect.objectContaining({ action: "search", resultCount: 1, truncated: false }),
		]);
	});
});
