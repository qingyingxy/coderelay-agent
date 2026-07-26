import { describe, expect, it } from "vitest";
import {
	applyPromptBudget,
	PromptBudgetError,
	type PromptTokenEstimator,
} from "../../src/core/workflow/prompt-budget.ts";
import { createPromptEnvelope, type PromptContextEntry } from "../../src/core/workflow/prompt-envelope.ts";
import { NOW } from "./fixtures.ts";

const TOKEN_COSTS: Readonly<Record<string, number>> = {
	profile: 5,
	rule: 4,
	"history-1": 8,
	"history-2": 7,
	request: 5,
	plan: 6,
	task: 5,
	"required-handoff": 9,
	"optional-handoff": 4,
	tools: 3,
};

const estimateTokens: PromptTokenEstimator = (text) => {
	const value = JSON.parse(text) as { id?: string };
	return value.id ? (TOKEN_COSTS[value.id] ?? 1) : 10;
};

function context(id: string, source: PromptContextEntry["source"], required = false): PromptContextEntry {
	return {
		id,
		source,
		content: `${id} content`,
		required,
	};
}

function createEnvelope() {
	return createPromptEnvelope({
		promptVersion: "worker-v1",
		createdAt: NOW,
		role: "worker",
		profileName: "worker",
		task: {
			id: "task-1",
			workflowId: "workflow-1",
			title: "Implement request",
			description: "Implement the current Task",
			status: "ready",
			dependencyIds: [],
			verificationRequirements: [],
		},
		context: [
			context("profile", "agent_profile"),
			context("rule", "project_rule"),
			context("history-1", "history"),
			context("history-2", "history"),
			context("request", "user_request"),
			context("plan", "plan"),
			context("task", "task"),
			context("required-handoff", "handoff", true),
			context("optional-handoff", "handoff"),
			context("tools", "tool_schema"),
		],
		toolNames: ["read", "edit", "write"],
		constraints: [
			{ id: "permission", kind: "permission", description: "Do not exceed inherited permissions" },
			{ id: "scope", kind: "workflow", description: "Only execute the current Task" },
		],
		outputSchema: {
			id: "worker-handoff",
			version: "1",
			jsonSchema: { type: "object" },
		},
	});
}

describe("Prompt budget", () => {
	it("removes optional context in deterministic priority order", () => {
		const envelope = createEnvelope();
		const result = applyPromptBudget(envelope, {
			maxInputTokens: 50,
			reservedTokens: 5,
			estimateTokens,
		});

		expect(result.estimatedTokensBefore).toBe(71);
		expect(result.estimatedTokensAfter).toBe(46);
		expect(result.removedContext.map(({ id }) => id)).toEqual(["history-1", "history-2", "optional-handoff", "plan"]);
		expect(result.envelope.context.map(({ id }) => id)).toEqual([
			"profile",
			"rule",
			"request",
			"task",
			"required-handoff",
			"tools",
		]);
		expect(result.envelope.constraints).toEqual(envelope.constraints);
		expect(envelope.context).toHaveLength(10);
	});

	it("never removes protected sources even when their required flag is false", () => {
		expect(() =>
			applyPromptBudget(createEnvelope(), {
				maxInputTokens: 30,
				estimateTokens,
			}),
		).toThrowError(
			expect.objectContaining({
				code: "prompt_budget.protected_content_exceeds_limit",
				requiredTokens: 34,
				maxInputTokens: 30,
			}),
		);
	});

	it("returns an unchanged clone when the Envelope fits", () => {
		const envelope = createEnvelope();
		const result = applyPromptBudget(envelope, {
			maxInputTokens: 100,
			estimateTokens,
		});

		expect(result.removedContext).toEqual([]);
		expect(result.estimatedTokensAfter).toBe(result.estimatedTokensBefore);
		expect(result.envelope).toEqual(envelope);
		expect(result.envelope).not.toBe(envelope);
	});

	it("rejects invalid budgets and estimator results", () => {
		expect(() =>
			applyPromptBudget(createEnvelope(), {
				maxInputTokens: 0,
				estimateTokens,
			}),
		).toThrow(PromptBudgetError);
		expect(() =>
			applyPromptBudget(createEnvelope(), {
				maxInputTokens: 100,
				reservedTokens: 100,
				estimateTokens,
			}),
		).toThrowError(expect.objectContaining({ code: "prompt_budget.invalid_reserve" }));
		expect(() =>
			applyPromptBudget(createEnvelope(), {
				maxInputTokens: 100,
				estimateTokens: () => -1,
			}),
		).toThrowError(expect.objectContaining({ code: "prompt_budget.invalid_estimate" }));
	});
});
