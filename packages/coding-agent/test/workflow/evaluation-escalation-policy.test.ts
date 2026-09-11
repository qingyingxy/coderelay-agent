import { describe, expect, it } from "vitest";
import {
	assertEvaluationEscalationRouting,
	EVALUATION_ESCALATION_POLICY,
	EvaluationEscalationPolicyError,
	evaluationRunTimeoutMs,
	evaluationSoftLimitTrigger,
} from "../../src/core/evaluation/escalation-policy.ts";

describe("evaluation escalation policy", () => {
	it("freezes one retry and combined accounting", () => {
		expect(EVALUATION_ESCALATION_POLICY).toMatchObject({
			softTurnRatio: 0.6,
			softDurationRatio: 0.6,
			orchestrationGraceMs: 120_000,
			maxRetries: 1,
			preserveWorkspaceState: true,
			usageAccounting: "combined",
			infrastructureFailureDisposition: "aborted_resumable",
			completedFailureDisposition: "final",
		});
		expect(EVALUATION_ESCALATION_POLICY.strongEscalationReasons).toEqual([
			"soft_limit",
			"no_progress",
			"repeated_failure",
			"verification_failure",
		]);
	});

	it("keeps orchestration time outside the Workflow execution budget", () => {
		expect(evaluationRunTimeoutMs(EVALUATION_ESCALATION_POLICY, 120_000)).toBe(240_000);
	});

	it("triggers at sixty percent of either hard limit", () => {
		expect(
			evaluationSoftLimitTrigger(EVALUATION_ESCALATION_POLICY, {
				turns: 11,
				elapsedMs: 71_999,
				maxTurns: 20,
				maxDurationMs: 120_000,
			}),
		).toBeUndefined();
		expect(
			evaluationSoftLimitTrigger(EVALUATION_ESCALATION_POLICY, {
				turns: 12,
				elapsedMs: 1,
				maxTurns: 20,
				maxDurationMs: 120_000,
			}),
		).toBe("soft_turn_limit");
		expect(
			evaluationSoftLimitTrigger(EVALUATION_ESCALATION_POLICY, {
				turns: 1,
				elapsedMs: 72_000,
				maxTurns: 20,
				maxDurationMs: 120_000,
			}),
		).toBe("soft_duration_limit");
	});

	it("requires all routed model tiers before a paid run", () => {
		expect(() =>
			assertEvaluationEscalationRouting({
				enabled: true,
				fastModel: "test/fast",
				balancedModel: "test/balanced",
				strongModel: "test/strong",
			}),
		).not.toThrow();
		expect(() => assertEvaluationEscalationRouting({ enabled: true, fastModel: "test/fast" })).toThrow(
			EvaluationEscalationPolicyError,
		);
		expect(() => assertEvaluationEscalationRouting({ enabled: false })).not.toThrow();
	});
});
