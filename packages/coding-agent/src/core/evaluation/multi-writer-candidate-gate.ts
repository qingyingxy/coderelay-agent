import type { EvaluationMetrics } from "./types.ts";

export interface MultiWriterCandidateEvidence {
	readonly baseline: EvaluationMetrics;
	readonly multiWriter: EvaluationMetrics;
	readonly integrationAttempts: number;
	readonly conflictAttempts: number;
	readonly rollbackAttempts: number;
	readonly successfulRollbacks: number;
}

export interface MultiWriterCandidateThresholds {
	readonly minimumRunsPerStrategy: number;
	readonly minimumDurationReduction: number;
	readonly maximumSuccessRateRegression: number;
	readonly maximumCostExpansionRatio: number;
	readonly maximumConflictRate: number;
}

export const DEFAULT_MULTI_WRITER_CANDIDATE_THRESHOLDS: MultiWriterCandidateThresholds = {
	minimumRunsPerStrategy: 3,
	minimumDurationReduction: 0.15,
	maximumSuccessRateRegression: 0,
	maximumCostExpansionRatio: 1.5,
	maximumConflictRate: 0.1,
};

export type MultiWriterCandidateReasonCode =
	| "multi_writer.insufficient_evidence"
	| "multi_writer.no_duration_gain"
	| "multi_writer.quality_regression"
	| "multi_writer.cost_expansion"
	| "multi_writer.conflict_rate"
	| "multi_writer.rollback_unproven";

export interface MultiWriterCandidateFinding {
	readonly reasonCode: MultiWriterCandidateReasonCode;
	readonly summary: string;
}

export interface MultiWriterCandidateResult {
	readonly eligible: boolean;
	readonly findings: readonly MultiWriterCandidateFinding[];
}

export function evaluateMultiWriterCandidate(
	evidence: MultiWriterCandidateEvidence,
	thresholds: MultiWriterCandidateThresholds = DEFAULT_MULTI_WRITER_CANDIDATE_THRESHOLDS,
): MultiWriterCandidateResult {
	const findings: MultiWriterCandidateFinding[] = [];
	if (
		evidence.baseline.runs < thresholds.minimumRunsPerStrategy ||
		evidence.multiWriter.runs < thresholds.minimumRunsPerStrategy
	) {
		findings.push({
			reasonCode: "multi_writer.insufficient_evidence",
			summary: `Multi-Writer evaluation requires at least ${thresholds.minimumRunsPerStrategy} runs per strategy`,
		});
	}
	const durationReduction =
		evidence.baseline.averageDurationMs <= 0
			? 0
			: 1 - evidence.multiWriter.averageDurationMs / evidence.baseline.averageDurationMs;
	if (durationReduction < thresholds.minimumDurationReduction) {
		findings.push({
			reasonCode: "multi_writer.no_duration_gain",
			summary: `Multi-Writer duration reduction ${durationReduction.toFixed(3)} is below the required gain`,
		});
	}
	if (evidence.multiWriter.successRate < evidence.baseline.successRate - thresholds.maximumSuccessRateRegression) {
		findings.push({
			reasonCode: "multi_writer.quality_regression",
			summary: "Multi-Writer success rate regressed",
		});
	}
	if (
		evidence.baseline.usage.cost > 0 &&
		evidence.multiWriter.usage.cost / evidence.baseline.usage.cost > thresholds.maximumCostExpansionRatio
	) {
		findings.push({
			reasonCode: "multi_writer.cost_expansion",
			summary: "Multi-Writer cost expansion exceeds the allowed ratio",
		});
	}
	const conflictRate =
		evidence.integrationAttempts === 0 ? 1 : evidence.conflictAttempts / evidence.integrationAttempts;
	if (conflictRate > thresholds.maximumConflictRate) {
		findings.push({
			reasonCode: "multi_writer.conflict_rate",
			summary: `Multi-Writer conflict rate ${conflictRate.toFixed(3)} exceeds the allowed rate`,
		});
	}
	if (evidence.rollbackAttempts === 0 || evidence.successfulRollbacks !== evidence.rollbackAttempts) {
		findings.push({
			reasonCode: "multi_writer.rollback_unproven",
			summary: "Multi-Writer rollback has not been proven for every failed post-integration verification",
		});
	}
	return { eligible: findings.length === 0, findings };
}
