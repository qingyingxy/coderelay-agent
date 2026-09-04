import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession compact command routing", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps generated-summary compaction in summary mode", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "configured summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compactForCommand("retain decisions");

		expect(result).toMatchObject({
			strategy: "summary",
			summaryGenerated: true,
			compaction: { summary: "configured summary" },
		});
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_window")).toBe(false);
	});

	it("routes windowed compact to a hard cut without generating a summary", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("objective");

		const result = await harness.session.compactForCommand("this would have guided a summary");

		expect(result).toMatchObject({
			strategy: "hard_cut",
			summaryGenerated: false,
			pending: false,
			customInstructionsIgnored: true,
			boundary: { type: "context_window", reason: "manual" },
		});
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("handles /compact through the same hard-cut route and emits an explicit presentation result", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("unused")]);
		await harness.session.prompt("objective");

		await harness.session.prompt("/compact focus on constraints");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_window")).toHaveLength(1);
		const output = harness.eventsOfType("message_end").at(-1)?.message;
		expect(output).toMatchObject({
			role: "custom",
			customType: "context-management-command",
			display: true,
			details: {
				command: "/compact",
				strategy: "hard_cut",
				summaryGenerated: false,
				customInstructionsIgnored: true,
			},
		});
		expect(getMessageText(output)).toContain("no summary was generated");
	});
});
