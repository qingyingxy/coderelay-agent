import type { AgentPermissionCeiling } from "./agent-profile.ts";
import type { BudgetLimit, ResourceUsage } from "./types.ts";

export type PermissionSet = AgentPermissionCeiling;

export const FULL_PERMISSION_SET: PermissionSet = {
	read: true,
	write: true,
	executeCommands: true,
	network: true,
	allowedPaths: [],
	deniedPaths: [],
	denyAllPaths: false,
};

export interface EffectivePermissionInput {
	readonly parent: PermissionSet;
	readonly profile: PermissionSet;
	readonly workflow: PermissionSet;
	readonly task: PermissionSet;
}

export type BudgetDimension = keyof BudgetLimit;

export interface BudgetCounterSnapshot {
	readonly activeAgents?: number;
	readonly activeJobs?: number;
	readonly agentDepth?: number;
	readonly retries?: number;
}

export interface BudgetFinding {
	readonly dimension: BudgetDimension;
	readonly severity: "warning" | "exceeded";
	readonly used: number;
	readonly limit: number;
}

export interface BudgetEvaluation {
	readonly warnings: readonly BudgetFinding[];
	readonly exceeded: readonly BudgetFinding[];
}

export class RuntimePolicyError extends Error {
	readonly code: string;
	readonly findings: readonly BudgetFinding[];

	constructor(code: string, message: string, findings: readonly BudgetFinding[] = []) {
		super(message);
		this.name = "RuntimePolicyError";
		this.code = code;
		this.findings = findings;
	}
}

const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
	"maxInputTokens",
	"maxOutputTokens",
	"maxCost",
	"maxTurns",
	"maxDurationMs",
	"maxConcurrentAgents",
	"maxConcurrentJobs",
	"maxAgentDepth",
	"maxRetries",
];

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const COMMAND_TOOLS = new Set(["bash"]);
const CAPACITY_DIMENSIONS: ReadonlySet<BudgetDimension> = new Set([
	"maxConcurrentAgents",
	"maxConcurrentJobs",
	"maxAgentDepth",
	"maxRetries",
]);

function normalizedPath(path: string): string {
	return path.trim().replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function pathContains(parent: string, child: string): boolean {
	const normalizedParent = normalizedPath(parent);
	const normalizedChild = normalizedPath(child);
	return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

interface AllowedPathIntersection {
	readonly allowedPaths: readonly string[];
	readonly denyAllPaths: boolean;
}

function intersectAllowedPaths(left: readonly string[], right: readonly string[]): AllowedPathIntersection {
	if (left.length === 0) {
		return { allowedPaths: [...new Set(right.map(normalizedPath))], denyAllPaths: false };
	}
	if (right.length === 0) {
		return { allowedPaths: [...new Set(left.map(normalizedPath))], denyAllPaths: false };
	}
	const intersection: string[] = [];
	for (const leftPath of left) {
		for (const rightPath of right) {
			if (pathContains(leftPath, rightPath)) {
				intersection.push(normalizedPath(rightPath));
			} else if (pathContains(rightPath, leftPath)) {
				intersection.push(normalizedPath(leftPath));
			}
		}
	}
	const allowedPaths = [...new Set(intersection)];
	return { allowedPaths, denyAllPaths: allowedPaths.length === 0 };
}

export function intersectPermissions(left: PermissionSet, right: PermissionSet): PermissionSet {
	const pathIntersection = intersectAllowedPaths(left.allowedPaths, right.allowedPaths);
	return {
		read: left.read && right.read,
		write: left.write && right.write,
		executeCommands: left.executeCommands && right.executeCommands,
		network: left.network && right.network,
		allowedPaths: pathIntersection.allowedPaths,
		deniedPaths: [...new Set([...left.deniedPaths, ...right.deniedPaths].map(normalizedPath))],
		denyAllPaths: Boolean(left.denyAllPaths || right.denyAllPaths || pathIntersection.denyAllPaths),
	};
}

export function resolveEffectivePermissions(input: EffectivePermissionInput): PermissionSet {
	return [input.profile, input.workflow, input.task].reduce(intersectPermissions, input.parent);
}

export function permissionAllowsPath(permission: PermissionSet, path: string): boolean {
	if (permission.denyAllPaths) {
		return false;
	}
	const normalized = normalizedPath(path);
	if (permission.deniedPaths.some((deniedPath) => pathContains(deniedPath, normalized))) {
		return false;
	}
	return (
		permission.allowedPaths.length === 0 ||
		permission.allowedPaths.some((allowedPath) => pathContains(allowedPath, normalized))
	);
}

export function filterToolsByPermissions(toolNames: readonly string[], permission: PermissionSet): readonly string[] {
	return toolNames.filter((toolName) => {
		if (READ_TOOLS.has(toolName)) {
			return permission.read;
		}
		if (WRITE_TOOLS.has(toolName)) {
			return permission.write;
		}
		if (COMMAND_TOOLS.has(toolName)) {
			return permission.executeCommands;
		}
		return false;
	});
}

export function inheritBudgetLimits(...limits: readonly BudgetLimit[]): BudgetLimit {
	const inherited: Partial<Record<BudgetDimension, number>> = {};
	for (const dimension of BUDGET_DIMENSIONS) {
		const values = limits.map((limit) => limit[dimension]).filter((value): value is number => value !== undefined);
		if (values.length > 0) {
			inherited[dimension] = Math.min(...values);
		}
	}
	return inherited;
}

function budgetUsage(dimension: BudgetDimension, usage: ResourceUsage, counters: BudgetCounterSnapshot): number {
	switch (dimension) {
		case "maxInputTokens":
			return usage.inputTokens;
		case "maxOutputTokens":
			return usage.outputTokens;
		case "maxCost":
			return usage.cost;
		case "maxTurns":
			return usage.turns;
		case "maxDurationMs":
			return usage.durationMs;
		case "maxConcurrentAgents":
			return counters.activeAgents ?? 0;
		case "maxConcurrentJobs":
			return counters.activeJobs ?? 0;
		case "maxAgentDepth":
			return counters.agentDepth ?? 0;
		case "maxRetries":
			return counters.retries ?? 0;
	}
}

export function evaluateBudget(
	limit: BudgetLimit,
	usage: ResourceUsage,
	counters: BudgetCounterSnapshot = {},
): BudgetEvaluation {
	const warnings: BudgetFinding[] = [];
	const exceeded: BudgetFinding[] = [];
	for (const dimension of BUDGET_DIMENSIONS) {
		const maximum = limit[dimension];
		if (maximum === undefined) {
			continue;
		}
		const used = budgetUsage(dimension, usage, counters);
		if (CAPACITY_DIMENSIONS.has(dimension) ? used > maximum : used >= maximum) {
			exceeded.push({ dimension, severity: "exceeded", used, limit: maximum });
		} else if (maximum > 0 && used / maximum >= 0.8) {
			warnings.push({ dimension, severity: "warning", used, limit: maximum });
		}
	}
	return { warnings, exceeded };
}

export function assertBudgetAvailable(
	limit: BudgetLimit,
	usage: ResourceUsage,
	counters: BudgetCounterSnapshot = {},
): BudgetEvaluation {
	const evaluation = evaluateBudget(limit, usage, counters);
	if (evaluation.exceeded.length > 0) {
		throw new RuntimePolicyError(
			"runtime_policy.budget_exhausted",
			`Budget exhausted: ${evaluation.exceeded.map(({ dimension }) => dimension).join(", ")}`,
			evaluation.exceeded,
		);
	}
	return evaluation;
}

export function formatBudgetEvaluation(evaluation: BudgetEvaluation): string {
	if (evaluation.exceeded.length > 0) {
		return `Budget exceeded: ${evaluation.exceeded.map(({ dimension, used, limit }) => `${dimension} ${used}/${limit}`).join(", ")}`;
	}
	if (evaluation.warnings.length > 0) {
		return `Budget warning: ${evaluation.warnings.map(({ dimension, used, limit }) => `${dimension} ${used}/${limit}`).join(", ")}`;
	}
	return "Budget: within limits";
}

export function sumResourceUsage(usages: readonly ResourceUsage[]): ResourceUsage {
	return usages.reduce(
		(total, usage) => ({
			inputTokens: total.inputTokens + usage.inputTokens,
			outputTokens: total.outputTokens + usage.outputTokens,
			cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
			cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
			cost: total.cost + usage.cost,
			turns: total.turns + usage.turns,
			durationMs: total.durationMs + usage.durationMs,
		}),
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0,
			turns: 0,
			durationMs: 0,
		},
	);
}
