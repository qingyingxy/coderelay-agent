import type { DecisionReasonCode } from "../workflow/decision-reasons.ts";
import type { ModelRouteRecord, ModelRouteRole, ModelTier } from "../workflow/model-gateway.ts";
import type { ResourceUsage } from "../workflow/types.ts";
import type { EvaluationEscalationPolicy } from "./escalation-policy.ts";

export const EVALUATION_SCHEMA_VERSION = 3;
export const EVALUATION_PROTOCOL_VERSION = "model-routing-v4";

export const EVALUATION_PROTOCOL_STATUSES = ["satisfied", "not_reached_after_quality_failure", "violated"] as const;
export type EvaluationProtocolStatus = (typeof EVALUATION_PROTOCOL_STATUSES)[number];

export const EVALUATION_STRATEGIES = [
	"single_agent",
	"main_explorer",
	"main_reviewer",
	"planner_worker_reviewer",
	"automatic",
] as const;
export type EvaluationStrategy = (typeof EVALUATION_STRATEGIES)[number];

export const EVALUATION_DIFFICULTIES = ["simple", "medium", "hard"] as const;
export type EvaluationDifficulty = (typeof EVALUATION_DIFFICULTIES)[number];

export interface EvaluationExpectedModelRoute {
	readonly role: ModelRouteRole;
	readonly tier: ModelTier;
	readonly minimumCount: number;
}

export interface EvaluationTaskSource {
	readonly dataset: string;
	readonly repository: string;
	readonly revision: string;
	readonly taskId: string;
	readonly license: string;
	readonly adaptation: string;
}

export interface EvaluationBudget {
	readonly maxCost: number;
	readonly maxTurns: number;
	readonly maxDurationMs: number;
	readonly maxAgents: number;
}

export interface EvaluationLocalRuntime {
	readonly executable: string;
	readonly executableBaseline: string;
	readonly nodeModules: string;
	readonly nodeModulesBaseline: string;
}

export interface EvaluationTask {
	readonly id: string;
	readonly title: string;
	readonly repositoryFixture: string;
	readonly repositoryBaseline: string;
	readonly prompt: string;
	readonly promptVersion: string;
	readonly verificationCommands: readonly string[];
	readonly protectedPaths: readonly string[];
	readonly successCriteria: readonly string[];
	readonly expectedReviewerFindings: readonly string[];
	readonly budget: EvaluationBudget;
	readonly difficulty?: EvaluationDifficulty;
	readonly expectedStrategy?: EvaluationStrategy;
	readonly expectedModelRoutes?: readonly EvaluationExpectedModelRoute[];
	readonly source?: EvaluationTaskSource;
	readonly localRuntime?: EvaluationLocalRuntime;
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
	| "verification_integrity"
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
	readonly repetition: number;
	readonly runConfigurationDigest: string;
	readonly model: EvaluationModelIdentity;
	readonly repositoryBaseline: string;
	readonly promptDigest: string;
	readonly promptVersion: string;
	readonly strategyPromptDigest: string;
	readonly strategyProtocolVersion: string;
	readonly evaluationProtocolVersion: string;
	readonly escalationPolicy: EvaluationEscalationPolicy;
	readonly budget: EvaluationBudget;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly succeeded: boolean;
	readonly protocolStatus: EvaluationProtocolStatus;
	readonly protocolViolations: readonly string[];
	readonly verificationIntegrityPassed: boolean;
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
	readonly difficulty?: EvaluationDifficulty;
	readonly expectedStrategy?: EvaluationStrategy;
	readonly selectedStrategy?: EvaluationStrategy;
	readonly routingEnabled?: boolean;
	readonly modelRoutes?: readonly ModelRouteRecord[];
	readonly actualModelNames: readonly string[];
	readonly requiredModelRoutes?: number;
	readonly reachedModelRoutes?: number;
	readonly matchedModelRoutes?: number;
	readonly taskSource?: EvaluationTaskSource;
	readonly failureType?: EvaluationFailureType;
	readonly failureMessage?: string;
	readonly limitations: readonly string[];
}

export interface EvaluationMetrics {
	readonly runs: number;
	readonly successes: number;
	readonly successRate: number;
	readonly protocolValidityRate: number;
	readonly verificationIntegrityRate: number;
	readonly verificationPassRate: number | null;
	readonly reviewerEffectiveFindingRate: number | null;
	readonly repairSuccessRate: number | null;
	readonly invalidDelegationRate: number | null;
	readonly handoffCompletenessRate: number | null;
	readonly decisionExplanationRate: number | null;
	readonly routingAccuracy: number | null;
	readonly routingCoverage: number | null;
	readonly expectedStrategyMatchRate: number | null;
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
	readonly averageDurationDeltaMs: number;
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

export interface EvaluationCheckpoint {
	readonly schemaVersion: number;
	readonly configurationDigest: string;
	readonly runs: readonly EvaluationRunRecord[];
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
