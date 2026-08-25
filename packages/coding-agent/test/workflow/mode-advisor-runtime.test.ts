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
			promptVersion: "mode-advisor-v3",
			role: "mode_advisor",
			profileName: "mode-advisor",
			toolNames: [],
			outputSchema: {
				jsonSchema: {
					properties: {
						clarificationCandidates: {
							items: {
								properties: {
									impact: {
										enum: ["scope", "behavior", "architecture", "safety", "verification", "preference"],
									},
								},
							},
						},
					},
				},
			},
		});
		expect(envelope.constraints.find(({ id }) => id === "mode-advisor-complexity-rubric")?.description).toContain(
			"Promise coalescing",
		);
		expect(envelope.constraints.find(({ id }) => id === "mode-advisor-complexity-rubric")?.description).toContain(
			"cross-module or distributed concurrency",
		);
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

		expect(result.advice).toMatchObject({ taskLevel: "hard", suggestedMode: "plan" });
		expect(result.clarification).toMatchObject({
			required: true,
			questions: [{ id: "migration-target" }],
		});
	});

	it("preserves valid advice when an optional clarification candidate is malformed", () => {
		const result = parseModeAdvisorResult(
			JSON.stringify({
				complexity: "medium",
				riskLevel: "low",
				confidence: "medium",
				reason: "The change is bounded to one asynchronous cache component",
				clarificationCandidates: [
					{
						id: "ttl-policy",
						question: "Should reads extend the TTL?",
						impact: "Determines whether reads extend the TTL",
						changesImplementation: true,
					},
				],
			}),
		);

		expect(result.advice).toMatchObject({ taskLevel: "medium", suggestedMode: "direct" });
		expect(result.candidates).toEqual([]);
		expect(result.clarification.required).toBe(false);
	});
});
