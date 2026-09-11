import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assessEvaluationProtocol,
	buildEvaluationReport,
	calculateEvaluationMetrics,
	classifyEvaluationFailure,
	countReachedModelRoutes,
	digestProtectedPaths,
	EVALUATION_ESCALATION_POLICY,
	EVALUATION_PROTOCOL_VERSION,
	EVALUATION_SCHEMA_VERSION,
	EvaluationCheckpointError,
	EvaluationComparisonError,
	EvaluationManifestError,
	type EvaluationRunRecord,
	evaluateRegressionGate,
	formatEvaluationReportMarkdown,
	isEvaluationInfrastructureFailure,
	parseEvaluationCheckpoint,
	parseEvaluationTaskSet,
	remainingEvaluationDurationMs,
	summarizeEvaluationRepairs,
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
		repetition: 1,
		runConfigurationDigest: `sha256:config-${strategy}`,
		model: { provider: "test", model: "fixed-model", thinkingLevel: "medium" },
		repositoryBaseline: "sha256:baseline",
		promptDigest: "sha256:prompt",
		promptVersion: "v1",
		strategyPromptDigest: `sha256:${strategy}`,
		strategyProtocolVersion: "r16-strategy-v1",
		evaluationProtocolVersion: EVALUATION_PROTOCOL_VERSION,
		escalationPolicy: EVALUATION_ESCALATION_POLICY,
		budget: { maxCost: 2, maxTurns: 20, maxDurationMs: 60_000, maxAgents: 4 },
		startedAt: "2026-07-29T00:00:00.000Z",
		endedAt: "2026-07-29T00:00:01.000Z",
		succeeded: true,
		protocolStatus: "satisfied",
		protocolViolations: [],
		verificationIntegrityPassed: true,
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
		actualModelNames: ["test/fixed-model"],
		limitations: [],
		...overrides,
	};
}

describe("R16 evaluation", () => {
	it("shares one deadline across evaluation phases", () => {
		expect(remainingEvaluationDurationMs(1_300, 1_000)).toBe(300);
		expect(remainingEvaluationDurationMs(1_300, 1_400)).toBe(0);
	});

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
					protectedPaths: ["test", "package.json"],
					successCriteria: ["Tests pass"],
					expectedReviewerFindings: ["finding"],
					difficulty: "medium",
					expectedStrategy: "main_reviewer",
					expectedModelRoutes: [{ role: "reviewer", tier: "balanced", minimumCount: 1 }],
					source: {
						dataset: "Public benchmark",
						repository: "https://example.test/benchmark",
						revision: "abc123",
						taskId: "upstream-task",
						license: "MIT",
						adaptation: "Verifier adapted to the local harness",
					},
					localRuntime: {
						executable: "../../.artifacts/node.exe",
						executableBaseline: "sha256:node",
						nodeModules: "../../.artifacts/node_modules",
						nodeModulesBaseline: "sha256:dependencies",
					},
					budget: { maxCost: 1, maxTurns: 10, maxDurationMs: 1_000, maxAgents: 2 },
				},
			],
		});

		expect(taskSet.tasks[0]).toMatchObject({
			id: "task",
			repositoryBaseline: "sha256:baseline",
			difficulty: "medium",
			expectedStrategy: "main_reviewer",
			expectedModelRoutes: [{ role: "reviewer", tier: "balanced", minimumCount: 1 }],
			protectedPaths: ["test", "package.json"],
			source: { dataset: "Public benchmark", revision: "abc123", taskId: "upstream-task" },
			localRuntime: {
				executableBaseline: "sha256:node",
				nodeModulesBaseline: "sha256:dependencies",
			},
		});
		expect(() =>
			parseEvaluationTaskSet({
				schemaVersion: EVALUATION_SCHEMA_VERSION,
				id: "invalid",
				version: "1.0.0",
				tasks: [
					{
						...taskSet.tasks[0],
						protectedPaths: ["../test"],
					},
				],
			}),
		).toThrow(EvaluationManifestError);
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
			protocolValidityRate: 1,
			verificationIntegrityRate: 1,
			verificationPassRate: 0.75,
			reviewerEffectiveFindingRate: 0.25,
			repairSuccessRate: 0.5,
			invalidDelegationRate: 0.25,
			handoffCompletenessRate: 0.75,
			decisionExplanationRate: 0.5,
			routingAccuracy: null,
			routingCoverage: null,
			expectedStrategyMatchRate: null,
			averageCostPerSuccess: 2,
		});
	});

	it("detects protected verification changes", () => {
		const root = mkdtempSync(join(tmpdir(), "evaluation-integrity-"));
		try {
			mkdirSync(join(root, "src"));
			mkdirSync(join(root, "test"));
			writeFileSync(join(root, "src", "code.js"), "export const value = 1;\n");
			writeFileSync(join(root, "test", "code.test.js"), "test('value', () => {});\n");
			writeFileSync(join(root, "package.json"), "{}\n");
			const baseline = digestProtectedPaths(root, ["test", "package.json"]);

			writeFileSync(join(root, "src", "code.js"), "export const value = 2;\n");
			expect(digestProtectedPaths(root, ["test", "package.json"])).toBe(baseline);

			writeFileSync(join(root, "test", "code.test.js"), "test('changed', () => {});\n");
			expect(digestProtectedPaths(root, ["test", "package.json"])).not.toBe(baseline);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects stale and duplicate checkpoints", () => {
		const checkpoint = {
			schemaVersion: EVALUATION_SCHEMA_VERSION,
			configurationDigest: "sha256:current",
			runs: [run("single_agent")],
		};
		expect(parseEvaluationCheckpoint(checkpoint, "sha256:current").runs).toHaveLength(1);
		expect(() => parseEvaluationCheckpoint(checkpoint, "sha256:changed")).toThrow(EvaluationCheckpointError);
		expect(() =>
			parseEvaluationCheckpoint(
				{ ...checkpoint, runs: [run("single_agent", { evaluationProtocolVersion: "model-routing-v1" })] },
				"sha256:current",
			),
		).toThrow(EvaluationCheckpointError);
		expect(() => parseEvaluationCheckpoint({ ...checkpoint, schemaVersion: 2 }, "sha256:current")).toThrow(
			EvaluationCheckpointError,
		);
		expect(() =>
			parseEvaluationCheckpoint(
				{ ...checkpoint, runs: [run("single_agent"), run("single_agent")] },
				"sha256:current",
			),
		).toThrow(EvaluationCheckpointError);
	});

	it("separates routing accuracy from routing coverage", () => {
		const metrics = calculateEvaluationMetrics([
			run("single_agent", {
				routingEnabled: true,
				requiredModelRoutes: 2,
				reachedModelRoutes: 2,
				matchedModelRoutes: 2,
				expectedStrategy: "single_agent",
			}),
			run("single_agent", {
				routingEnabled: true,
				requiredModelRoutes: 2,
				reachedModelRoutes: 1,
				matchedModelRoutes: 1,
				expectedStrategy: "single_agent",
			}),
			run("single_agent", {
				routingEnabled: false,
				requiredModelRoutes: 2,
				reachedModelRoutes: 2,
				matchedModelRoutes: 0,
			}),
		]);

		expect(metrics.routingAccuracy).toBe(1);
		expect(metrics.routingCoverage).toBe(0.75);
		expect(metrics.expectedStrategyMatchRate).toBe(1);
	});

	it("uses the LLM-selected strategy when evaluating automatic classification", () => {
		const metrics = calculateEvaluationMetrics([
			run("automatic", {
				expectedStrategy: "main_reviewer",
				selectedStrategy: "main_reviewer",
			}),
			run("automatic", {
				runId: "run-automatic-mismatch",
				expectedStrategy: "planner_worker_reviewer",
				selectedStrategy: "main_reviewer",
			}),
		]);

		expect(metrics.expectedStrategyMatchRate).toBe(0.5);
	});

	it("distinguishes deferred protocol requirements from protocol violations", () => {
		const qualityFailure = {
			violations: ["reviewer-before-delivery was not reached"],
			protocolStatePresent: true,
			protocolRunFailedOrIncomplete: false,
			verificationFailed: true,
			verificationIntegrityPassed: true,
			infrastructureFailure: false,
			protocolRuntimeFailure: false,
		};

		expect(assessEvaluationProtocol(qualityFailure)).toBe("not_reached_after_quality_failure");
		expect(assessEvaluationProtocol({ ...qualityFailure, protocolRunFailedOrIncomplete: true })).toBe("violated");
		expect(assessEvaluationProtocol({ ...qualityFailure, verificationFailed: false })).toBe("violated");
		expect(assessEvaluationProtocol({ ...qualityFailure, protocolRuntimeFailure: true })).toBe("violated");
		expect(
			countReachedModelRoutes(
				[
					{ role: "planner", tier: "strong", minimumCount: 1 },
					{ role: "reviewer", tier: "balanced", minimumCount: 1 },
				],
				{ planner: 2 },
			),
		).toBe(1);
	});

	it("reports a shared-deadline timeout as the primary failure", () => {
		expect(
			classifyEvaluationFailure({
				succeeded: false,
				verificationIntegrityPassed: true,
				infrastructureFailure: false,
				timedOut: true,
				protocolStatus: "violated",
				runtimeFailed: true,
				budgetExceeded: false,
			}),
		).toBe("timeout");
		expect(
			classifyEvaluationFailure({
				succeeded: false,
				verificationIntegrityPassed: true,
				infrastructureFailure: false,
				timedOut: false,
				protocolStatus: "violated",
				runtimeFailed: false,
				budgetExceeded: false,
			}),
		).toBe("strategy_protocol");
	});

	it("classifies provider billing, authentication, and availability errors as infrastructure", () => {
		expect(isEvaluationInfrastructureFailure('402: {"message":"Insufficient Balance"}')).toBe(true);
		expect(isEvaluationInfrastructureFailure("401 invalid_api_key")).toBe(true);
		expect(isEvaluationInfrastructureFailure("503 Service Unavailable")).toBe(true);
		expect(isEvaluationInfrastructureFailure("Planner response does not contain a JSON object")).toBe(false);
	});

	it("counts Direct and Task-based Repair attempts without double counting", () => {
		expect(summarizeEvaluationRepairs([], 1, true)).toEqual({ attempts: 1, successes: 1 });
		expect(summarizeEvaluationRepairs(["succeeded"], 1, true)).toEqual({ attempts: 1, successes: 1 });
		expect(summarizeEvaluationRepairs([], 1, false)).toEqual({ attempts: 1, successes: 0 });
		expect(summarizeEvaluationRepairs(["failed", "succeeded"], 2, true)).toEqual({
			attempts: 2,
			successes: 1,
		});
	});

	it("rejects unfair comparisons and reports marginal multi-Agent benefit", () => {
		expect(() =>
			buildEvaluationReport([run("single_agent", { evaluationProtocolVersion: "model-routing-v1" })]),
		).toThrow(EvaluationComparisonError);
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
			averageDurationDeltaMs: 200,
		});
		expect(formatEvaluationReportMarkdown(report)).toContain("Protocol");

		const repeated = buildEvaluationReport([
			run("single_agent", { runId: "single-1", repetition: 1 }),
			run("single_agent", { runId: "single-2", repetition: 2 }),
			run("automatic", { runId: "automatic-1", repetition: 1 }),
			run("automatic", { runId: "automatic-2", repetition: 2 }),
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

	it("evaluates the fixed report strategy instead of requiring automatic", () => {
		const baseline = buildEvaluationReport([run("planner_worker_reviewer")], "planner_worker_reviewer");
		const candidate = buildEvaluationReport([run("planner_worker_reviewer")], "planner_worker_reviewer");

		expect(evaluateRegressionGate(baseline, candidate, candidate.baselineStrategy)).toMatchObject({
			passed: true,
			failures: [],
		});
	});

	it("rejects regression comparisons containing infrastructure failures", () => {
		const baseline = buildEvaluationReport([run("planner_worker_reviewer")], "planner_worker_reviewer");
		const candidate = buildEvaluationReport(
			[
				run("planner_worker_reviewer", {
					succeeded: false,
					failureType: "infrastructure",
				}),
			],
			"planner_worker_reviewer",
		);

		expect(evaluateRegressionGate(baseline, candidate, candidate.baselineStrategy)).toMatchObject({
			passed: false,
			failures: [
				expect.objectContaining({
					reasonCode: "evaluation.incomparable",
					summary: expect.stringContaining("infrastructure failures"),
				}),
			],
		});
	});
});
