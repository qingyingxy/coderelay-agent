import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createModelRoutingOptionsFromEnv,
	ModelGateway,
	type ModelGatewayRuntime,
	selectModelTier,
} from "../../src/core/workflow/model-gateway.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function runtime(models: readonly Model<Api>[]): ModelGatewayRuntime {
	return {
		getModel: (provider, id) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
		hasConfiguredAuth: () => true,
	};
}

describe("Model Gateway", () => {
	it("maps workflow roles to cost-aware tiers", () => {
		expect(selectModelTier({ role: "planner" }).tier).toBe("strong");
		expect(selectModelTier({ role: "planner_lite" }).tier).toBe("balanced");
		expect(selectModelTier({ role: "main", riskLevel: "low" }).tier).toBe("fast");
		expect(selectModelTier({ role: "main", riskLevel: "medium" }).tier).toBe("fast");
		expect(selectModelTier({ role: "main", riskLevel: "high" }).tier).toBe("strong");
		expect(selectModelTier({ role: "worker", riskLevel: "high" }).tier).toBe("balanced");
		expect(selectModelTier({ role: "reviewer", riskLevel: "low" }).tier).toBe("balanced");
		expect(selectModelTier({ role: "reviewer", riskLevel: "high" }).tier).toBe("strong");
		expect(selectModelTier({ role: "repair" }).tier).toBe("strong");
	});

	it("keeps ordinary retries on their role tier and reserves strong escalation for verification failures", () => {
		const selection = selectModelTier({
			role: "worker",
			escalationReason: "retry",
			budget: { maxCost: 1 },
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0.1,
				turns: 0,
				durationMs: 0,
			},
		});
		expect(selection).toMatchObject({ tier: "balanced", reasonCode: "model.retry_role_tier" });
		expect(selectModelTier({ role: "repair", escalationReason: "verification_failure" })).toMatchObject({
			tier: "strong",
			reasonCode: "model.verification_failure_escalated_strong",
		});
		expect(selectModelTier({ role: "worker", escalationReason: "no_progress" })).toMatchObject({
			tier: "strong",
			reasonCode: "model.no_progress_escalated_strong",
		});
		expect(selectModelTier({ role: "worker", escalationReason: "repeated_failure" })).toMatchObject({
			tier: "strong",
			reasonCode: "model.repeated_failure_escalated_strong",
		});
	});

	it("downgrades non-trivial work when the remaining cost budget is tight", () => {
		const selection = selectModelTier({
			role: "planner",
			budget: { maxCost: 1 },
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0.8,
				turns: 0,
				durationMs: 0,
			},
		});
		expect(selection.tier).toBe("balanced");
		expect(selection.reasonCode).toBe("model.budget_pressure_downgrade");
	});

	it("selects configured models and preserves explicit user choices", () => {
		const fast = model("test", "fast");
		const balanced = model("test", "balanced");
		const strong = model("test", "strong");
		const gateway = new ModelGateway(runtime([fast, balanced, strong]), {
			enabled: true,
			fastModel: "test/fast",
			balancedModel: "test/balanced",
			strongModel: "test/strong",
		});

		const planner = gateway.route({ role: "planner", currentModel: fast });
		expect(planner.model).toBe(strong);
		expect(planner.record).toMatchObject({
			role: "planner",
			tier: "strong",
			modelName: "test/strong",
			source: "configured",
			reasonCode: "model.planner.strong",
		});

		const explicit = gateway.route({ role: "main", currentModel: fast, explicitModel: true });
		expect(explicit.model).toBe(fast);
		expect(explicit.record.source).toBe("explicit");

		const retried = gateway.route({
			role: "worker",
			currentModel: fast,
			explicitModel: true,
			escalationReason: "retry",
		});
		expect(retried.model).toBe(balanced);
		expect(retried.record).toMatchObject({
			tier: "balanced",
			source: "configured",
			reasonCode: "model.retry_role_tier",
		});
	});

	it("falls back when a configured tier model is unavailable", () => {
		const current = model("test", "current");
		const gateway = new ModelGateway(runtime([current]), {
			enabled: true,
			fastModel: "test/missing",
		});
		const decision = gateway.route({ role: "main", currentModel: current, riskLevel: "low" });
		expect(decision.model).toBe(current);
		expect(decision.record).toMatchObject({ source: "fallback", reasonCode: "model.target_unavailable" });
	});

	it("loads tier mappings from environment variables", () => {
		expect(
			createModelRoutingOptionsFromEnv({
				PI_MODEL_ROUTING: "auto",
				PI_MODEL_FAST: "test/fast",
				PI_MODEL_STRONG: "test/strong",
			}),
		).toMatchObject({ enabled: true, fastModel: "test/fast", strongModel: "test/strong" });
	});
});
