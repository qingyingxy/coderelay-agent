import { describe, expect, it } from "vitest";
import {
	buildEvaluationReport,
	calculateEvaluationMetrics,
	EVALUATION_SCHEMA_VERSION,
	EvaluationComparisonError,
	EvaluationManifestError,
	type EvaluationRunRecord,
	evaluateRegressionGate,
	formatEvaluationReportMarkdown,
	parseEvaluationTaskSet,
} from "../../src/index.ts";
import { ZERO_USAGE } from "./fixtures.ts";

function run(
	strategy: EvaluationRunRecord["strategy"],
	overrides: Partial<EvaluationRunRecord> = {},
): EvaluationRunRecord {
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		runId: `run-${strategy}`,
		taskSetId: "task-set",
		taskSetVersion: "1.0.0",
		taskId: "task-1",
		strategy,
		model: { provider: "test", model: "fixed-model", thinkingLevel: "medium" },
		repositoryBaseline: "sha256:baseline",
		promptDigest: "sha256:prompt",
		promptVersion: "v1",
		strategyPromptDigest: `sha256:${strategy}`,
		strategyProtocolVersion: "r16-strategy-v1",
		budget: { maxCost: 2, maxTurns: 20, maxDurationMs: 60_000, maxAgents: 4 },
		startedAt: "2026-07-29T00:00:00.000Z",
		endedAt: "2026-07-29T00:00:01.000Z",
		succeeded: true,
		requiredVerifications: 2,
		passedVerifications: 2,
		reviewerFindings: 2,
		validReviewerFindings: 1,
		repairAttempts: 1,
		successfulRepairs: 1,
		delegations: 2,
		invalidDelegations: 0,
		handoffs: 2,
		completeHandoffs: 2,
		agentCount: 3,
		usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 50, cost: 1, turns: 4, durationMs: 1_000 },
		decisionReasonCodes: ["mode.default_direct"],
		automaticDecisionCount: 1,
		limitations: [],
		...overrides,
	};
}

describe("R16 evaluation", () => {
	it("validates a versioned fixed Task Set", () => {
		const taskSet = parseEvaluationTaskSet({
			schemaVersion: EVALUATION_SCHEMA_VERSION,
			id: "fixed",
			version: "1.0.0",
			tasks: [
				{
					id: "task",
					title: "Task",
					repositoryFixture: "fixtures/task",
					repositoryBaseline: "sha256:baseline",
					prompt: "Fix the defect",
					promptVersion: "v1",
					verificationCommands: ["node --test"],
					successCriteria: ["Tests pass"],
					expectedReviewerFindings: ["finding"],
					budget: { maxCost: 1, maxTurns: 10, maxDurationMs: 1_000, maxAgents: 2 },
				},
			],
		});

		expect(taskSet.tasks[0]).toMatchObject({
			id: "task",
			repositoryBaseline: "sha256:baseline",
		});
		expect(() => parseEvaluationTaskSet({ schemaVersion: 99, tasks: [] })).toThrow(EvaluationManifestError);
	});

	it("aggregates quality, cost, repair, Handoff, and explanation metrics", () => {
		const metrics = calculateEvaluationMetrics([
			run("single_agent"),
			run("single_agent", {
				succeeded: false,
				passedVerifications: 1,
				validReviewerFindings: 0,
				successfulRepairs: 0,
				invalidDelegations: 1,
				completeHandoffs: 1,
				decisionReasonCodes: [],
			}),
		]);

		expect(metrics).toMatchObject({
			runs: 2,
			successes: 1,
			successRate: 0.5,
			verificationPassRate: 0.75,
			reviewerEffectiveFindingRate: 0.25,
			repairSuccessRate: 0.5,
			invalidDelegationRate: 0.25,
			handoffCompletenessRate: 0.75,
			decisionExplanationRate: 0.5,
			averageCostPerSuccess: 2,
		});
	});

	it("rejects unfair comparisons and reports marginal multi-Agent benefit", () => {
		expect(() =>
			buildEvaluationReport([
				run("single_agent"),
				run("automatic", { budget: { maxCost: 3, maxTurns: 20, maxDurationMs: 60_000, maxAgents: 4 } }),
			]),
		).toThrow(EvaluationComparisonError);
		expect(() =>
			buildEvaluationReport([
				run("single_agent", { runId: "single-1" }),
				run("single_agent", {
					runId: "single-2",
					strategyPromptDigest: "sha256:changed",
				}),
			]),
		).toThrow(EvaluationComparisonError);

		const report = buildEvaluationReport([
			run("single_agent"),
			run("automatic", {
				usage: { ...ZERO_USAGE, cost: 1.5, turns: 6, durationMs: 1_200 },
			}),
		]);
		expect(report.comparisons[0]).toMatchObject({
			strategy: "automatic",
			successRateDelta: 0,
			costDelta: 0.5,
		});
		expect(formatEvaluationReportMarkdown(report)).toContain("Decision explanation");

		const repeated = buildEvaluationReport([
			run("single_agent", { runId: "single-1" }),
			run("single_agent", { runId: "single-2" }),
			run("automatic", { runId: "automatic-1" }),
			run("automatic", { runId: "automatic-2" }),
		]);
		expect(repeated.strategies.map(({ metrics }) => metrics.runs)).toEqual([2, 2]);
	});

	it("blocks quality, cost, and unexplained-decision regressions", () => {
		const baseline = buildEvaluationReport([run("single_agent"), run("automatic")]);
		const candidate = buildEvaluationReport([
			run("single_agent"),
			run("automatic", {
				succeeded: false,
				passedVerifications: 1,
				usage: { ...ZERO_USAGE, cost: 2, turns: 5, durationMs: 1_000 },
				decisionReasonCodes: [],
				failureType: "verification",
			}),
		]);

		expect(evaluateRegressionGate(baseline, candidate).failures.map(({ reasonCode }) => reasonCode)).toEqual([
			"evaluation.quality_regression",
			"evaluation.verification_regression",
			"evaluation.cost_expansion",
			"evaluation.unexplained_decisions",
		]);
	});
});
