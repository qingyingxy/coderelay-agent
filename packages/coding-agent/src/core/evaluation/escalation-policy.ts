import type { ModelEscalationReason, ModelRoutingOptions } from "../workflow/model-gateway.ts";

export const EVALUATION_ESCALATION_POLICY_VERSION = "single-strong-escalation-v2";

export type EvaluationSoftLimitTrigger = "soft_turn_limit" | "soft_duration_limit";

export interface EvaluationEscalationPolicy {
	readonly version: string;
	readonly softTurnRatio: number;
	readonly softDurationRatio: number;
	readonly orchestrationGraceMs: number;
	readonly maxRetries: number;
	readonly strongEscalationReasons: readonly ModelEscalationReason[];
	readonly preserveWorkspaceState: boolean;
	readonly usageAccounting: "combined";
	readonly infrastructureFailureDisposition: "aborted_resumable";
	readonly completedFailureDisposition: "final";
}

export interface EvaluationSoftLimitInput {
	readonly turns: number;
	readonly elapsedMs: number;
	readonly maxTurns: number;
	readonly maxDurationMs: number;
}

export class EvaluationEscalationPolicyError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EvaluationEscalationPolicyError";
		this.code = code;
	}
}

export const EVALUATION_ESCALATION_POLICY: EvaluationEscalationPolicy = Object.freeze({
	version: EVALUATION_ESCALATION_POLICY_VERSION,
	softTurnRatio: 0.6,
	softDurationRatio: 0.6,
	orchestrationGraceMs: 120_000,
	maxRetries: 1,
	strongEscalationReasons: Object.freeze([
		"soft_limit",
		"no_progress",
		"repeated_failure",
		"verification_failure",
	] satisfies ModelEscalationReason[]),
	preserveWorkspaceState: true,
	usageAccounting: "combined",
	infrastructureFailureDisposition: "aborted_resumable",
	completedFailureDisposition: "final",
});

export function evaluationRunTimeoutMs(policy: EvaluationEscalationPolicy, executionBudgetMs: number): number {
	if (
		!Number.isFinite(executionBudgetMs) ||
		executionBudgetMs < 0 ||
		!Number.isFinite(policy.orchestrationGraceMs) ||
		policy.orchestrationGraceMs < 0
	) {
		throw new EvaluationEscalationPolicyError(
			"evaluation.invalid_run_timeout",
			"Evaluation execution budget and orchestration grace must be non-negative finite durations",
		);
	}
	return executionBudgetMs + policy.orchestrationGraceMs;
}

export function evaluationSoftLimitTrigger(
	policy: EvaluationEscalationPolicy,
	input: EvaluationSoftLimitInput,
): EvaluationSoftLimitTrigger | undefined {
	const turnLimit = Math.ceil(input.maxTurns * policy.softTurnRatio);
	if (input.turns >= turnLimit) return "soft_turn_limit";
	const durationLimitMs = Math.ceil(input.maxDurationMs * policy.softDurationRatio);
	return input.elapsedMs >= durationLimitMs ? "soft_duration_limit" : undefined;
}

export function assertEvaluationEscalationRouting(options: ModelRoutingOptions): void {
	if (options.enabled !== true) return;
	const missingTiers = [
		...(options.fastModel ? [] : ["fast"]),
		...(options.balancedModel ? [] : ["balanced"]),
		...(options.strongModel ? [] : ["strong"]),
	];
	if (missingTiers.length > 0) {
		throw new EvaluationEscalationPolicyError(
			"evaluation.escalation_model_missing",
			`Gateway evaluation requires configured ${missingTiers.join(", ")} tier models`,
		);
	}
}
