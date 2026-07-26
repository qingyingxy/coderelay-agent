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
			suggestedMode: "direct",
		});
	});

	it("allows a medium-complexity Direct suggestion when risk is low", () => {
		expect(
			adviseExecutionMode({
				complexity: "medium",
				riskLevel: "low",
				confidence: "medium",
				reason: "The affected boundary is known and verification is focused",
			}).suggestedMode,
		).toBe("direct");
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
	])("suggests Plan for $name", ({ complexity, riskLevel, confidence }) => {
		expect(
			adviseExecutionMode({
				complexity,
				riskLevel,
				confidence,
				reason: "Planning is the conservative choice",
			}).suggestedMode,
		).toBe("plan");
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
