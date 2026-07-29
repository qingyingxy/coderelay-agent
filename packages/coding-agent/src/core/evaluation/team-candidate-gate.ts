import type { EvaluationMetrics } from "./types.ts";

export interface AgentTeamCandidateEvidence {
	readonly baseline: EvaluationMetrics;
	readonly team: EvaluationMetrics;
}

export interface AgentTeamCandidateThresholds {
	readonly minimumRunsPerStrategy: number;
	readonly minimumSuccessRateGain: number;
	readonly minimumVerificationRateGain: number;
	readonly maximumCostExpansionRatio: number;
	readonly requiredDecisionExplanationRate: number;
}

export const DEFAULT_AGENT_TEAM_CANDIDATE_THRESHOLDS: AgentTeamCandidateThresholds = {
	minimumRunsPerStrategy: 3,
	minimumSuccessRateGain: 0.05,
	minimumVerificationRateGain: 0.1,
	maximumCostExpansionRatio: 2,
	requiredDecisionExplanationRate: 1,
};

export type AgentTeamCandidateReasonCode =
	| "agent_team.insufficient_evidence"
	| "agent_team.no_quality_gain"
	| "agent_team.collaboration_regression"
	| "agent_team.cost_expansion"
	| "agent_team.unexplained_decisions";

export interface AgentTeamCandidateFinding {
	readonly reasonCode: AgentTeamCandidateReasonCode;
	readonly summary: string;
}

export interface AgentTeamCandidateResult {
	readonly eligible: boolean;
	readonly findings: readonly AgentTeamCandidateFinding[];
}

export function evaluateAgentTeamCandidate(
	evidence: AgentTeamCandidateEvidence,
	thresholds: AgentTeamCandidateThresholds = DEFAULT_AGENT_TEAM_CANDIDATE_THRESHOLDS,
): AgentTeamCandidateResult {
	const findings: AgentTeamCandidateFinding[] = [];
	const { baseline, team } = evidence;
	if (baseline.runs < thresholds.minimumRunsPerStrategy || team.runs < thresholds.minimumRunsPerStrategy) {
		findings.push({
			reasonCode: "agent_team.insufficient_evidence",
			summary: `Agent Team evaluation requires at least ${thresholds.minimumRunsPerStrategy} runs per strategy`,
		});
	}
	const successGain = team.successRate - baseline.successRate;
	const verificationGain =
		team.verificationPassRate === null || baseline.verificationPassRate === null
			? null
			: team.verificationPassRate - baseline.verificationPassRate;
	if (
		successGain < thresholds.minimumSuccessRateGain &&
		(verificationGain === null || verificationGain < thresholds.minimumVerificationRateGain)
	) {
		findings.push({
			reasonCode: "agent_team.no_quality_gain",
			summary: "Agent Team did not produce the required success-rate or verification gain",
		});
	}
	if (
		team.invalidDelegationRate !== null &&
		baseline.invalidDelegationRate !== null &&
		team.invalidDelegationRate > baseline.invalidDelegationRate
	) {
		findings.push({
			reasonCode: "agent_team.collaboration_regression",
			summary: "Agent Team increased the invalid delegation rate",
		});
	}
	if (baseline.usage.cost > 0 && team.usage.cost / baseline.usage.cost > thresholds.maximumCostExpansionRatio) {
		findings.push({
			reasonCode: "agent_team.cost_expansion",
			summary: `Agent Team cost expanded ${(team.usage.cost / baseline.usage.cost).toFixed(2)}x`,
		});
	}
	if (
		team.decisionExplanationRate === null ||
		team.decisionExplanationRate < thresholds.requiredDecisionExplanationRate
	) {
		findings.push({
			reasonCode: "agent_team.unexplained_decisions",
			summary: "Agent Team contains unexplained automatic decisions",
		});
	}
	return { eligible: findings.length === 0, findings };
}
