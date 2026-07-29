import { calculateEvaluationMetrics } from "./metrics.ts";
import type { EvaluationComparison, EvaluationReport, EvaluationRunRecord, EvaluationStrategyReport } from "./types.ts";
import { EVALUATION_STRATEGIES, type EvaluationStrategy } from "./types.ts";

export class EvaluationComparisonError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EvaluationComparisonError";
		this.code = code;
	}
}

function stable(value: unknown): string {
	return JSON.stringify(value);
}

export function assertComparableEvaluationRuns(runs: readonly EvaluationRunRecord[]): void {
	if (runs.length === 0) {
		throw new EvaluationComparisonError("evaluation.runs_required", "Evaluation requires at least one Run");
	}
	const first = runs[0]!;
	for (const run of runs) {
		if (run.taskSetId !== first.taskSetId || run.taskSetVersion !== first.taskSetVersion) {
			throw new EvaluationComparisonError("evaluation.task_set_mismatch", "Runs use different Task Sets");
		}
		if (stable(run.model) !== stable(first.model)) {
			throw new EvaluationComparisonError("evaluation.model_mismatch", "Runs use different fixed Models");
		}
	}
	const taskFairness = new Map<
		string,
		{ repositoryBaseline: string; promptDigest: string; promptVersion: string; budget: string }
	>();
	const strategyProtocols = new Map<string, { digest: string; version: string }>();
	for (const run of runs) {
		const existing = taskFairness.get(run.taskId);
		const current = {
			repositoryBaseline: run.repositoryBaseline,
			promptDigest: run.promptDigest,
			promptVersion: run.promptVersion,
			budget: stable(run.budget),
		};
		if (existing && stable(existing) !== stable(current)) {
			throw new EvaluationComparisonError(
				"evaluation.unfair_comparison",
				`Task ${run.taskId} changed baseline, Prompt, or budget between strategies`,
			);
		}
		taskFairness.set(run.taskId, current);
		const protocolKey = `${run.strategy}:${run.taskId}`;
		const protocol = {
			digest: run.strategyPromptDigest,
			version: run.strategyProtocolVersion,
		};
		const existingProtocol = strategyProtocols.get(protocolKey);
		if (existingProtocol && stable(existingProtocol) !== stable(protocol)) {
			throw new EvaluationComparisonError(
				"evaluation.unfair_comparison",
				`Strategy protocol changed between repetitions for ${protocolKey}`,
			);
		}
		strategyProtocols.set(protocolKey, protocol);
	}
	const strategies = [...new Set(runs.map(({ strategy }) => strategy))];
	const taskCounts = (strategy: EvaluationStrategy): Readonly<Record<string, number>> => {
		const counts: Record<string, number> = {};
		for (const run of runs.filter((entry) => entry.strategy === strategy)) {
			counts[run.taskId] = (counts[run.taskId] ?? 0) + 1;
		}
		return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
	};
	const expectedTaskCounts = taskCounts(strategies[0]!);
	for (const strategy of strategies) {
		if (stable(taskCounts(strategy)) !== stable(expectedTaskCounts)) {
			throw new EvaluationComparisonError(
				"evaluation.incomplete_strategy",
				`Strategy ${strategy} does not cover the same Task repetitions`,
			);
		}
	}
}

function strategyReport(strategy: EvaluationStrategy, runs: readonly EvaluationRunRecord[]): EvaluationStrategyReport {
	const failures: Record<string, number> = {};
	for (const run of runs) {
		if (run.failureType) {
			failures[run.failureType] = (failures[run.failureType] ?? 0) + 1;
		}
	}
	return {
		strategy,
		metrics: calculateEvaluationMetrics(runs),
		failureTypes: failures,
	};
}

export function buildEvaluationReport(
	runs: readonly EvaluationRunRecord[],
	baselineStrategy: EvaluationStrategy = "single_agent",
	generatedAt = new Date().toISOString(),
): EvaluationReport {
	assertComparableEvaluationRuns(runs);
	const first = runs[0]!;
	const presentStrategies = EVALUATION_STRATEGIES.filter((strategy) => runs.some((run) => run.strategy === strategy));
	const strategies = presentStrategies.map((strategy) =>
		strategyReport(
			strategy,
			runs.filter((run) => run.strategy === strategy),
		),
	);
	const baseline = strategies.find(({ strategy }) => strategy === baselineStrategy);
	if (!baseline) {
		throw new EvaluationComparisonError(
			"evaluation.baseline_missing",
			`Baseline Strategy ${baselineStrategy} is missing`,
		);
	}
	const comparisons: EvaluationComparison[] = strategies
		.filter(({ strategy }) => strategy !== baselineStrategy)
		.map(({ strategy, metrics }) => {
			const successRateDelta = metrics.successRate - baseline.metrics.successRate;
			const costDelta = metrics.usage.cost - baseline.metrics.usage.cost;
			return {
				strategy,
				baselineStrategy,
				successRateDelta,
				costDelta,
				marginalSuccessPerAddedCost: costDelta > 0 ? successRateDelta / costDelta : null,
			};
		});
	return {
		schemaVersion: first.schemaVersion,
		taskSetId: first.taskSetId,
		taskSetVersion: first.taskSetVersion,
		generatedAt,
		model: first.model,
		baselineStrategy,
		strategies,
		comparisons,
		runs: structuredClone(runs),
		limitations: [...new Set(runs.flatMap(({ limitations }) => limitations))],
	};
}

function percent(value: number | null): string {
	return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function formatEvaluationReportMarkdown(report: EvaluationReport): string {
	const lines = [
		`# CLI Agent Evaluation: ${report.taskSetId} ${report.taskSetVersion}`,
		"",
		`Model: ${report.model.provider}/${report.model.model} (${report.model.thinkingLevel})`,
		`Baseline: ${report.baselineStrategy}`,
		"",
		"| Strategy | Success | Verification | Reviewer findings | Repair | Invalid delegation | Handoff | Decision explanation | Cost | Cost/success | Turns | Duration |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const { strategy, metrics } of report.strategies) {
		lines.push(
			`| ${strategy} | ${percent(metrics.successRate)} | ${percent(metrics.verificationPassRate)} | ${percent(metrics.reviewerEffectiveFindingRate)} | ${percent(metrics.repairSuccessRate)} | ${percent(metrics.invalidDelegationRate)} | ${percent(metrics.handoffCompletenessRate)} | ${percent(metrics.decisionExplanationRate)} | $${metrics.usage.cost.toFixed(4)} | ${metrics.averageCostPerSuccess === null ? "n/a" : `$${metrics.averageCostPerSuccess.toFixed(4)}`} | ${metrics.usage.turns} | ${Math.round(metrics.usage.durationMs)}ms |`,
		);
	}
	lines.push("", "## Marginal benefit", "");
	for (const comparison of report.comparisons) {
		lines.push(
			`- ${comparison.strategy}: success ${(comparison.successRateDelta * 100).toFixed(1)}pp; cost ${comparison.costDelta >= 0 ? "+" : ""}$${comparison.costDelta.toFixed(4)}; marginal success/cost ${comparison.marginalSuccessPerAddedCost?.toFixed(4) ?? "n/a"}`,
		);
	}
	if (report.limitations.length > 0) {
		lines.push("", "## Limitations", "", ...report.limitations.map((limitation) => `- ${limitation}`));
	}
	return `${lines.join("\n")}\n`;
}
