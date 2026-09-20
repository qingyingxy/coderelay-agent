import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	correctedReplayFrame,
	loadReplayFixture,
	originalReplayFrames,
	scoreReplayFrame,
} from "../../evals/context-window/handoff-replay.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("long recorded observations across actual Direct cuts", () => {
	it.each(["recorded-loss", "corrected", "early-loss-recovered"] as const)(
		"replays %s without model or shell access",
		async (scenario) => {
			const fixture = loadReplayFixture();
			const frames = originalReplayFrames(fixture);
			if (scenario !== "recorded-loss") frames[2] = correctedReplayFrame();
			if (scenario === "early-loss-recovered") {
				frames[1].brief = "Unverified checkpoint checks and docs command examples. Next: focused tests.";
				frames[1].claims = [
					{ requirement: "safe-upsert", status: "missing" },
					{
						requirement: "checkpoint-checks",
						status: "pending",
						quote: "Unverified checkpoint checks and docs command examples.",
					},
					{
						requirement: "docs-command-examples",
						status: "pending",
						quote: "Unverified checkpoint checks and docs command examples.",
					},
				];
			}
			let observations = 0;
			const tool: AgentTool = {
				name: "replay_observation",
				label: "Replay",
				description: "Return the next recorded tool observation; commands are inert text and are never executed.",
				parameters: Type.Object({}),
				execute: async () => {
					const window = fixture.windows[observations++];
					if (!window) throw new Error("Unexpected observation request");
					return { content: [{ type: "text", text: JSON.stringify(window.records) }], details: {} };
				},
			};
			const harness = await createHarness({
				settings: { contextManagement: { mode: "windowed" } },
				tools: [tool],
				initialActiveToolNames: ["replay_observation", "new_context", "history"],
				allowedToolNames: ["replay_observation", "new_context", "history"],
			});
			try {
				harness.session.enableWorkflowTracking("direct");
				const responses: FauxResponseStep[] = [];
				for (const [index, frame] of frames.entries()) {
					responses.push((context) => {
						expect(context.tools?.map((active) => active.name).sort()).toEqual([
							"history",
							"new_context",
							"replay_observation",
						]);
						expect(JSON.stringify(context.messages)).not.toContain('"claims":');
						const text = context.messages.map(getMessageText).join("\n");
						if (index > 0) {
							expect(text).toContain(frames[index - 1].brief);
							expect(text).not.toContain(fixture.windows[index - 1].records[0].text);
							if (scenario === "early-loss-recovered" && index === 2) expect(text).not.toContain("safe upsert");
						}
						return fauxAssistantMessage(fauxToolCall("replay_observation", {}), { stopReason: "toolUse" });
					});
					responses.push((context) => {
						const text = context.messages.map(getMessageText).join("\n");
						const observation = JSON.stringify(fixture.windows[index].records);
						expect(text).toContain(observation);
						return fauxAssistantMessage(fauxToolCall("new_context", { handoff: frame.brief }), {
							stopReason: "toolUse",
						});
					});
				}
				responses.push((context) => {
					const text = context.messages.map(getMessageText).join("\n");
					expect(text).toContain(frames[2].brief);
					if (scenario === "recorded-loss") expect(text).not.toContain("safe upsert");
					return fauxAssistantMessage(fauxToolCall("history", { action: "search", query: "safe upsert" }), {
						stopReason: "toolUse",
					});
				});
				responses.push(() => fauxAssistantMessage("Replay complete; target status requires evidence review."));
				harness.setResponses(responses);
				await harness.session.prompt(fixture.instruction.text, {
					isolatedDirectExecution: { reason: "Offline recorded replay; Faux replies and inert observations only" },
				});
				expect(
					harness.session.messages.filter(
						(message) => message.role === "assistant" && message.stopReason === "error",
					),
				).toEqual([]);
				expect(harness.faux.state.callCount).toBe(8);
				expect(observations).toBe(3);
				expect(harness.eventsOfType("context_window_end")).toHaveLength(3);
				expect(harness.eventsOfType("history_query").some((event) => event.resultCount > 0)).toBe(true);
				const branch = harness.sessionManager.getBranch();
				expect(branch.filter((entry) => entry.type === "compaction")).toEqual([]);
				expect(
					branch.filter(
						(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
					),
				).toEqual([]);
				expect(harness.sessionManager.getMemoryNotes()).toEqual([]);
				expect(frames.flatMap((frame) => scoreReplayFrame(frame))).toEqual(
					scenario === "corrected" ? [] : ["safe-upsert:missing"],
				);
			} finally {
				harness.cleanup();
			}
		},
	);
});
