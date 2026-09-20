import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { makeMicroCases, makeMicroContext, readMicroHandoff } from "../evals/context-window/handoff-micro.ts";
import { createNewContextToolDefinition } from "../src/core/tools/new-context.ts";

describe("handoff micro evaluation boundaries", () => {
	it("does not restore an omitted requirement from the case ground truth on later cuts", () => {
		const sample = makeMicroCases()[0];
		const reply = fauxAssistantMessage(
			fauxToolCall("new_context", { handoff: "Existing tests passed. Next: final review." }),
			{ stopReason: "toolUse" },
		);
		const result = readMicroHandoff(reply, sample.initialBrief);
		const next = makeMicroContext("new", result.brief, sample.observations[2]);
		expect(JSON.stringify(next)).not.toContain(sample.feature);
		expect(result.omittedParameter).toBe(false);
	});
	it("preserves the old brief when the optional argument is absent, but rejects malformed or oversized replacements", () => {
		const reply = (args: Record<string, unknown>) =>
			fauxAssistantMessage(fauxToolCall("new_context", args), { stopReason: "toolUse" });
		expect(readMicroHandoff(reply({}), "Pending failure path")).toEqual({
			brief: "Pending failure path",
			omittedParameter: true,
		});
		for (const args of [
			{ handoff: " " },
			{ handoff: 3 },
			{ handoff: "a".repeat(2001) },
			{ handoff: "ok", unknown: true },
		]) {
			expect(() => readMicroHandoff(reply(args), "previous")).toThrow();
		}
		expect(() => readMicroHandoff(fauxAssistantMessage("not a tool call"), "previous")).toThrow();
	});
	it("pins the new tool guidance to production and pairs identical observations", () => {
		const tool = createNewContextToolDefinition(async () => {});
		expect(makeMicroContext("new", "", "").tools?.[0].parameters).toEqual(tool.parameters);
		const cases = makeMicroCases();
		expect(cases).toHaveLength(8);
		expect(cases.filter((sample) => sample.scenario === "pending")).toHaveLength(4);
		for (const sample of cases) {
			expect(sample.observations).toHaveLength(3);
			expect(makeMicroContext("old", sample.initialBrief, sample.observations[0]).messages).toEqual(
				makeMicroContext("new", sample.initialBrief, sample.observations[0]).messages,
			);
		}
	});
});
