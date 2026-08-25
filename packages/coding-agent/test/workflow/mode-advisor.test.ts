import { describe, expect, it } from "vitest";
import { adviseExecutionMode, ModeAdviceError } from "../../src/core/workflow/mode-advisor.ts";

describe("automatic execution mode advice", () => {
	it("suggests Direct for a confident, low-risk, non-complex task", () => {
		expect(
			adviseExecutionMode({
				complexity: "low",
				riskLevel: "low",
				confidence: "high",
				reason: "  The request is a localized text change  ",
			}),
		).toEqual({
			complexity: "low",
			riskLevel: "low",
			confidence: "high",
			reason: "The request is a localized text change",
			taskLevel: "simple",
			suggestedMode: "direct",
		});
	});

	it("keeps bounded medium-complexity work in Direct when risk is low", () => {
		expect(
			adviseExecutionMode({
				complexity: "medium",
				riskLevel: "low",
				confidence: "medium",
				reason: "The affected boundary is known and verification is focused",
			}),
		).toMatchObject({ taskLevel: "medium", suggestedMode: "direct" });
	});

	it.each([
		{
			name: "high complexity",
			complexity: "high" as const,
			riskLevel: "low" as const,
			confidence: "high" as const,
		},
		{
			name: "medium risk",
			complexity: "low" as const,
			riskLevel: "medium" as const,
			confidence: "high" as const,
		},
		{
			name: "low confidence",
			complexity: "low" as const,
			riskLevel: "low" as const,
			confidence: "low" as const,
		},
		{
			name: "high risk",
			complexity: "low" as const,
			riskLevel: "high" as const,
			confidence: "high" as const,
		},
	])("suggests Plan for $name", ({ complexity, riskLevel, confidence }) => {
		const advice = adviseExecutionMode({
			complexity,
			riskLevel,
			confidence,
			reason: "Planning is the conservative choice",
		});
		expect(advice.suggestedMode).toBe("plan");
		expect(advice.taskLevel).toBe(riskLevel === "high" ? "high_risk" : "hard");
	});

	it("rejects malformed runtime assessments", () => {
		expect(() =>
			adviseExecutionMode({
				complexity: "extreme" as "low",
				riskLevel: "low",
				confidence: "high",
				reason: "Invalid complexity",
			}),
		).toThrowError(expect.objectContaining({ code: "mode_advice.invalid_complexity" }));

		expect(() =>
			adviseExecutionMode({
				complexity: "low",
				riskLevel: "low",
				confidence: "high",
				reason: " ",
			}),
		).toThrow(ModeAdviceError);
	});
});
