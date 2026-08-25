import { sumResourceUsage } from "../workflow/runtime-policy.ts";
import type { EvaluationMetrics, EvaluationRunRecord } from "./types.ts";

function ratio(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

export function calculateEvaluationMetrics(runs: readonly EvaluationRunRecord[]): EvaluationMetrics {
	const usage = sumResourceUsage(runs.map((run) => run.usage));
	const successes = runs.filter(({ succeeded }) => succeeded).length;
	const protocolValidRuns = runs.filter(({ protocolStatus }) => protocolStatus !== "violated").length;
	const verificationIntegrityRuns = runs.filter(
		({ verificationIntegrityPassed }) => verificationIntegrityPassed,
	).length;
	const requiredVerifications = runs.reduce((total, run) => total + run.requiredVerifications, 0);
	const passedVerifications = runs.reduce((total, run) => total + run.passedVerifications, 0);
	const reviewerFindings = runs.reduce((total, run) => total + run.reviewerFindings, 0);
	const validReviewerFindings = runs.reduce((total, run) => total + run.validReviewerFindings, 0);
	const repairAttempts = runs.reduce((total, run) => total + run.repairAttempts, 0);
	const successfulRepairs = runs.reduce((total, run) => total + run.successfulRepairs, 0);
	const delegations = runs.reduce((total, run) => total + run.delegations, 0);
	const invalidDelegations = runs.reduce((total, run) => total + run.invalidDelegations, 0);
	const handoffs = runs.reduce((total, run) => total + run.handoffs, 0);
	const completeHandoffs = runs.reduce((total, run) => total + run.completeHandoffs, 0);
	const automaticDecisions = runs.reduce((total, run) => total + run.automaticDecisionCount, 0);
	const explainedDecisions = runs.reduce(
		(total, run) => total + Math.min(run.automaticDecisionCount, run.decisionReasonCodes.length),
		0,
	);
	const routedRuns = runs.filter(({ routingEnabled }) => routingEnabled === true);
	const requiredModelRoutes = routedRuns.reduce((total, run) => total + (run.requiredModelRoutes ?? 0), 0);
	const reachedModelRoutes = routedRuns.reduce((total, run) => total + (run.reachedModelRoutes ?? 0), 0);
	const matchedModelRoutes = routedRuns.reduce((total, run) => total + (run.matchedModelRoutes ?? 0), 0);
	const strategyRuns = runs.filter(({ expectedStrategy }) => expectedStrategy !== undefined);
	return {
		runs: runs.length,
		successes,
		successRate: ratio(successes, runs.length) ?? 0,
		protocolValidityRate: ratio(protocolValidRuns, runs.length) ?? 0,
		verificationIntegrityRate: ratio(verificationIntegrityRuns, runs.length) ?? 0,
		verificationPassRate: ratio(passedVerifications, requiredVerifications),
		reviewerEffectiveFindingRate: ratio(validReviewerFindings, reviewerFindings),
		repairSuccessRate: ratio(successfulRepairs, repairAttempts),
		invalidDelegationRate: ratio(invalidDelegations, delegations),
		handoffCompletenessRate: ratio(completeHandoffs, handoffs),
		decisionExplanationRate: ratio(explainedDecisions, automaticDecisions),
		routingAccuracy: ratio(matchedModelRoutes, reachedModelRoutes),
		routingCoverage: ratio(reachedModelRoutes, requiredModelRoutes),
		expectedStrategyMatchRate: ratio(
			strategyRuns.filter(
				({ selectedStrategy, strategy, expectedStrategy }) => (selectedStrategy ?? strategy) === expectedStrategy,
			).length,
			strategyRuns.length,
		),
		usage,
		averageCostPerSuccess: ratio(usage.cost, successes),
		averageDurationMs: ratio(usage.durationMs, runs.length) ?? 0,
		averageAgentCount:
			ratio(
				runs.reduce((total, run) => total + run.agentCount, 0),
				runs.length,
			) ?? 0,
	};
}
