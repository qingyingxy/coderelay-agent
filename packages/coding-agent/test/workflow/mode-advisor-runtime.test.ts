import { describe, expect, it } from "vitest";
import {
	createModeAdvisorPromptEnvelope,
	parseModeAdvisorResult,
} from "../../src/core/workflow/mode-advisor-runtime.ts";

describe("Mode Advisor runtime", () => {
	it("creates a tool-free Prompt Envelope", () => {
		const envelope = createModeAdvisorPromptEnvelope({
			createdAt: "2026-07-27T00:00:00.000Z",
			requestText: "Refactor the scheduler",
		});

		expect(envelope).toMatchObject({
			role: "mode_advisor",
			profileName: "mode-advisor",
			toolNames: [],
		});
	});

	it("derives Plan and preserves required clarification", () => {
		const result = parseModeAdvisorResult(
			JSON.stringify({
				complexity: "high",
				riskLevel: "medium",
				confidence: "low",
				reason: "The migration affects persisted state",
				clarificationCandidates: [
					{
						id: "migration-target",
						question: "Which persisted format is the target?",
						impact: "architecture",
						changesImplementation: true,
					},
				],
			}),
		);

		expect(result.advice.suggestedMode).toBe("plan");
		expect(result.clarification).toMatchObject({
			required: true,
			questions: [{ id: "migration-target" }],
		});
	});
});
