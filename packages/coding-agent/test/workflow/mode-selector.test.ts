import { describe, expect, it } from "vitest";
import type { ModeAdvice } from "../../src/core/workflow/mode-advisor.ts";
import { DEFAULT_RESOLVED_EXECUTION_MODE, selectExecutionMode } from "../../src/core/workflow/mode-selector.ts";

const DIRECT_ADVICE: ModeAdvice = {
	complexity: "low",
	riskLevel: "low",
	confidence: "high",
	reason: "The task is localized",
	suggestedMode: "direct",
};

const PLAN_ADVICE: ModeAdvice = {
	complexity: "high",
	riskLevel: "medium",
	confidence: "high",
	reason: "The task changes multiple architectural boundaries",
	suggestedMode: "plan",
};

describe("execution mode selection", () => {
	it("keeps an explicit Plan request as the strongest user choice", () => {
		expect(
			selectExecutionMode({
				requestedMode: "plan",
				forcePlan: true,
				agentAdvice: DIRECT_ADVICE,
				defaultMode: "direct",
			}),
		).toEqual({ mode: "plan", source: "user" });
	});

	it("lets a forced Plan policy veto an explicit Direct request", () => {
		expect(
			selectExecutionMode({
				requestedMode: "direct",
				forcePlan: true,
				agentAdvice: DIRECT_ADVICE,
			}),
		).toEqual({ mode: "plan", source: "forced_policy" });
	});

	it("uses an explicit Direct request before an Agent suggestion", () => {
		expect(
			selectExecutionMode({
				requestedMode: "direct",
				agentAdvice: PLAN_ADVICE,
				defaultMode: "plan",
			}),
		).toEqual({ mode: "direct", source: "user" });
	});

	it("uses an Agent suggestion before the default rule", () => {
		expect(
			selectExecutionMode({
				agentAdvice: PLAN_ADVICE,
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
