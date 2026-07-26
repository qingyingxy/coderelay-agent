import { describe, expect, it } from "vitest";
import { DEFAULT_RESOLVED_EXECUTION_MODE, selectExecutionMode } from "../../src/core/workflow/mode-selector.ts";

describe("execution mode selection", () => {
	it("keeps an explicit Plan request as the strongest user choice", () => {
		expect(
			selectExecutionMode({
				requestedMode: "plan",
				forcePlan: true,
				agentSuggestedMode: "direct",
				defaultMode: "direct",
			}),
		).toEqual({ mode: "plan", source: "user" });
	});

	it("lets a forced Plan policy veto an explicit Direct request", () => {
		expect(
			selectExecutionMode({
				requestedMode: "direct",
				forcePlan: true,
				agentSuggestedMode: "direct",
			}),
		).toEqual({ mode: "plan", source: "forced_policy" });
	});

	it("uses an explicit Direct request before an Agent suggestion", () => {
		expect(
			selectExecutionMode({
				requestedMode: "direct",
				agentSuggestedMode: "plan",
				defaultMode: "plan",
			}),
		).toEqual({ mode: "direct", source: "user" });
	});

	it("uses an Agent suggestion before the default rule", () => {
		expect(
			selectExecutionMode({
				agentSuggestedMode: "plan",
				defaultMode: "direct",
			}),
		).toEqual({ mode: "plan", source: "agent" });
	});

	it("falls back to Direct without interrupting the user", () => {
		expect(DEFAULT_RESOLVED_EXECUTION_MODE).toBe("direct");
		expect(selectExecutionMode({})).toEqual({ mode: "direct", source: "default" });
	});

	it("supports an explicit product fallback rule", () => {
		expect(selectExecutionMode({ defaultMode: "plan" })).toEqual({ mode: "plan", source: "default" });
	});
});
