import { describe, expect, it } from "vitest";
import { createModeDecision, ModeDecisionError } from "../../src/core/workflow/mode-decision.ts";
import { NOW } from "./fixtures.ts";

describe("ModeDecision", () => {
	it("creates a complete persisted decision from a resolved selection", () => {
		expect(
			createModeDecision({
				selection: { mode: "plan", source: "agent" },
				reason: "  The task affects several dependent modules  ",
				riskLevel: "medium",
				decidedAt: NOW,
			}),
		).toEqual({
			mode: "plan",
			source: "agent",
			reasonCode: "mode.agent_plan",
			reason: "The task affects several dependent modules",
			riskLevel: "medium",
			decidedAt: NOW,
		});
	});

	it("rejects an empty reason", () => {
		expect(() =>
			createModeDecision({
				selection: { mode: "direct", source: "default" },
				reason: " ",
				riskLevel: "low",
				decidedAt: NOW,
			}),
		).toThrow(ModeDecisionError);
	});

	it("rejects an invalid timestamp", () => {
		expect(() =>
			createModeDecision({
				selection: { mode: "direct", source: "default" },
				reason: "Use the product default",
				riskLevel: "low",
				decidedAt: "not-a-timestamp",
			}),
		).toThrowError(
			expect.objectContaining({
				code: "mode_decision.invalid_timestamp",
			}),
		);
	});

	it("rejects an invalid runtime risk level", () => {
		expect(() =>
			createModeDecision({
				selection: { mode: "direct", source: "default" },
				reason: "Use the product default",
				riskLevel: "critical" as "low",
				decidedAt: NOW,
			}),
		).toThrowError(
			expect.objectContaining({
				code: "mode_decision.invalid_risk",
			}),
		);
	});
});
