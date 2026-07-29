import type {
	EvaluationGateFailure,
	EvaluationGateResult,
	EvaluationMetrics,
	EvaluationRegressionThresholds,
	EvaluationReport,
	EvaluationStrategy,
} from "./types.ts";

export const DEFAULT_EVALUATION_REGRESSION_THRESHOLDS: EvaluationRegressionThresholds = {
	maximumSuccessRateRegression: 0.05,
	maximumVerificationRateRegression: 0.05,
	maximumCostExpansionRatio: 1.5,
	requiredDecisionExplanationRate: 1,
};

function metrics(report: EvaluationReport, strategy: EvaluationStrategy): EvaluationMetrics | undefined {
	return report.strategies.find((entry) => entry.strategy === strategy)?.metrics;
}

export function evaluateRegressionGate(
	baseline: EvaluationReport,
	candidate: EvaluationReport,
	strategy: EvaluationStrategy = "automatic",
	thresholds: EvaluationRegressionThresholds = DEFAULT_EVALUATION_REGRESSION_THRESHOLDS,
): EvaluationGateResult {
	const failures: EvaluationGateFailure[] = [];
	if (
		baseline.taskSetId !== candidate.taskSetId ||
		baseline.taskSetVersion !== candidate.taskSetVersion ||
		JSON.stringify(baseline.model) !== JSON.stringify(candidate.model)
	) {
		failures.push({
			reasonCode: "evaluation.incomparable",
			summary: "Baseline and candidate must use the same Task Set version and fixed Model",
		});
		return { passed: false, failures };
	}
	const previous = metrics(baseline, strategy);
	const next = metrics(candidate, strategy);
	if (!previous || !next) {
		failures.push({
			reasonCode: "evaluation.incomparable",
			summary: `Both reports must contain Strategy ${strategy}`,
		});
		return { passed: false, failures };
	}
	if (next.successRate < previous.successRate - thresholds.maximumSuccessRateRegression) {
		failures.push({
			reasonCode: "evaluation.quality_regression",
			summary: `Success rate regressed from ${previous.successRate.toFixed(3)} to ${next.successRate.toFixed(3)}`,
		});
	}
	if (
		previous.verificationPassRate !== null &&
		next.verificationPassRate !== null &&
		next.verificationPassRate < previous.verificationPassRate - thresholds.maximumVerificationRateRegression
	) {
		failures.push({
			reasonCode: "evaluation.verification_regression",
			summary: `Verification pass rate regressed from ${previous.verificationPassRate.toFixed(3)} to ${next.verificationPassRate.toFixed(3)}`,
		});
	}
	if (
		previous.usage.cost > 0 &&
		next.usage.cost / previous.usage.cost > thresholds.maximumCostExpansionRatio &&
		next.successRate <= previous.successRate
	) {
		failures.push({
			reasonCode: "evaluation.cost_expansion",
			summary: `Cost expanded ${(next.usage.cost / previous.usage.cost).toFixed(2)}x without a success-rate gain`,
		});
	}
	if (
		next.decisionExplanationRate === null ||
		next.decisionExplanationRate < thresholds.requiredDecisionExplanationRate
	) {
		failures.push({
			reasonCode: "evaluation.unexplained_decisions",
			summary: `Decision explanation rate ${next.decisionExplanationRate?.toFixed(3) ?? "n/a"} is below ${thresholds.requiredDecisionExplanationRate.toFixed(3)}`,
		});
	}
	return { passed: failures.length === 0, failures };
}
