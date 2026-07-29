import type { DecisionReasonCode } from "../workflow/decision-reasons.ts";
import type { ResourceUsage } from "../workflow/types.ts";

export const EVALUATION_SCHEMA_VERSION = 1;

export const EVALUATION_STRATEGIES = [
	"single_agent",
	"main_explorer",
	"main_reviewer",
	"planner_worker_reviewer",
	"automatic",
] as const;
export type EvaluationStrategy = (typeof EVALUATION_STRATEGIES)[number];

export interface EvaluationBudget {
	readonly maxCost: number;
	readonly maxTurns: number;
	readonly maxDurationMs: number;
	readonly maxAgents: number;
}

export interface EvaluationTask {
	readonly id: string;
	readonly title: string;
	readonly repositoryFixture: string;
	readonly repositoryBaseline: string;
	readonly prompt: string;
	readonly promptVersion: string;
	readonly verificationCommands: readonly string[];
	readonly successCriteria: readonly string[];
	readonly expectedReviewerFindings: readonly string[];
	readonly budget: EvaluationBudget;
}

export interface EvaluationTaskSet {
	readonly schemaVersion: number;
	readonly id: string;
	readonly version: string;
	readonly tasks: readonly EvaluationTask[];
}

export type EvaluationFailureType =
	| "model"
	| "verification"
	| "review"
	| "repair"
	| "budget"
	| "timeout"
	| "infrastructure"
	| "unexplained_decision"
	| "strategy_protocol";

export interface EvaluationModelIdentity {
	readonly provider: string;
	readonly model: string;
	readonly thinkingLevel: string;
}

export interface EvaluationRunRecord {
	readonly schemaVersion: number;
	readonly runId: string;
	readonly taskSetId: string;
	readonly taskSetVersion: string;
	readonly taskId: string;
	readonly strategy: EvaluationStrategy;
	readonly model: EvaluationModelIdentity;
	readonly repositoryBaseline: string;
	readonly promptDigest: string;
	readonly promptVersion: string;
	readonly strategyPromptDigest: string;
	readonly strategyProtocolVersion: string;
	readonly budget: EvaluationBudget;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly succeeded: boolean;
	readonly requiredVerifications: number;
	readonly passedVerifications: number;
	readonly reviewerFindings: number;
	readonly validReviewerFindings: number;
	readonly repairAttempts: number;
	readonly successfulRepairs: number;
	readonly delegations: number;
	readonly invalidDelegations: number;
	readonly handoffs: number;
	readonly completeHandoffs: number;
	readonly agentCount: number;
	readonly usage: ResourceUsage;
	readonly decisionReasonCodes: readonly DecisionReasonCode[];
	readonly automaticDecisionCount: number;
	readonly failureType?: EvaluationFailureType;
	readonly failureMessage?: string;
	readonly limitations: readonly string[];
}

export interface EvaluationMetrics {
	readonly runs: number;
	readonly successes: number;
	readonly successRate: number;
	readonly verificationPassRate: number | null;
	readonly reviewerEffectiveFindingRate: number | null;
	readonly repairSuccessRate: number | null;
	readonly invalidDelegationRate: number | null;
	readonly handoffCompletenessRate: number | null;
	readonly decisionExplanationRate: number | null;
	readonly usage: ResourceUsage;
	readonly averageCostPerSuccess: number | null;
	readonly averageDurationMs: number;
	readonly averageAgentCount: number;
}

export interface EvaluationStrategyReport {
	readonly strategy: EvaluationStrategy;
	readonly metrics: EvaluationMetrics;
	readonly failureTypes: Readonly<Record<string, number>>;
}

export interface EvaluationComparison {
	readonly strategy: EvaluationStrategy;
	readonly baselineStrategy: EvaluationStrategy;
	readonly successRateDelta: number;
	readonly costDelta: number;
	readonly marginalSuccessPerAddedCost: number | null;
}

export interface EvaluationReport {
	readonly schemaVersion: number;
	readonly taskSetId: string;
	readonly taskSetVersion: string;
	readonly generatedAt: string;
	readonly model: EvaluationModelIdentity;
	readonly baselineStrategy: EvaluationStrategy;
	readonly strategies: readonly EvaluationStrategyReport[];
	readonly comparisons: readonly EvaluationComparison[];
	readonly runs: readonly EvaluationRunRecord[];
	readonly limitations: readonly string[];
}

export interface EvaluationRegressionThresholds {
	readonly maximumSuccessRateRegression: number;
	readonly maximumVerificationRateRegression: number;
	readonly maximumCostExpansionRatio: number;
	readonly requiredDecisionExplanationRate: number;
}

export type EvaluationGateReasonCode =
	| "evaluation.incomparable"
	| "evaluation.quality_regression"
	| "evaluation.verification_regression"
	| "evaluation.cost_expansion"
	| "evaluation.unexplained_decisions";

export interface EvaluationGateFailure {
	readonly reasonCode: EvaluationGateReasonCode;
	readonly summary: string;
}

export interface EvaluationGateResult {
	readonly passed: boolean;
	readonly failures: readonly EvaluationGateFailure[];
}
