import { MODEL_TIERS, type ModelRouteRole } from "../workflow/model-gateway.ts";
import {
	EVALUATION_DIFFICULTIES,
	EVALUATION_SCHEMA_VERSION,
	EVALUATION_STRATEGIES,
	type EvaluationBudget,
	type EvaluationExpectedModelRoute,
	type EvaluationLocalRuntime,
	type EvaluationTask,
	type EvaluationTaskSet,
	type EvaluationTaskSource,
} from "./types.ts";

const MODEL_ROUTE_ROLES: readonly ModelRouteRole[] = [
	"mode_advisor",
	"planner",
	"planner_lite",
	"explorer",
	"worker",
	"reviewer",
	"main",
	"repair",
];

export class EvaluationManifestError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EvaluationManifestError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Readonly<Record<string, unknown>>, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context}.${key} must be a non-empty string`);
	}
	return value;
}

function requireStrings(record: Readonly<Record<string, unknown>>, key: string, context: string): readonly string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context}.${key} must contain strings`);
	}
	return [...value];
}

function requireProtectedPaths(record: Readonly<Record<string, unknown>>, context: string): readonly string[] {
	const paths = requireStrings(record, "protectedPaths", context);
	if (paths.length === 0) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context}.protectedPaths must not be empty`);
	}
	const normalized = paths.map((path) => path.replaceAll("\\", "/"));
	if (
		normalized.some(
			(path) =>
				path.startsWith("/") ||
				/^[a-z]:/i.test(path) ||
				path.split("/").some((segment) => segment === ".." || segment === ""),
		)
	) {
		throw new EvaluationManifestError(
			"evaluation.invalid_manifest",
			`${context}.protectedPaths must contain normalized relative paths`,
		);
	}
	if (new Set(normalized).size !== normalized.length) {
		throw new EvaluationManifestError(
			"evaluation.invalid_manifest",
			`${context}.protectedPaths must not contain duplicates`,
		);
	}
	return normalized;
}

function parseBudget(value: unknown, context: string): EvaluationBudget {
	if (!isRecord(value)) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context}.budget must be an object`);
	}
	const keys = ["maxCost", "maxTurns", "maxDurationMs", "maxAgents"] as const;
	for (const key of keys) {
		if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
			throw new EvaluationManifestError(
				"evaluation.invalid_manifest",
				`${context}.budget.${key} must be a non-negative number`,
			);
		}
	}
	return {
		maxCost: value.maxCost as number,
		maxTurns: value.maxTurns as number,
		maxDurationMs: value.maxDurationMs as number,
		maxAgents: value.maxAgents as number,
	};
}

function parseExpectedModelRoutes(value: unknown, context: string): readonly EvaluationExpectedModelRoute[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new EvaluationManifestError(
			"evaluation.invalid_manifest",
			`${context}.expectedModelRoutes must be a non-empty array`,
		);
	}
	return value.map((entry, index) => {
		const routeContext = `${context}.expectedModelRoutes[${index}]`;
		if (!isRecord(entry)) {
			throw new EvaluationManifestError("evaluation.invalid_manifest", `${routeContext} must be an object`);
		}
		const role = requireString(entry, "role", routeContext);
		if (!MODEL_ROUTE_ROLES.includes(role as ModelRouteRole)) {
			throw new EvaluationManifestError("evaluation.invalid_manifest", `${routeContext}.role is unsupported`);
		}
		const tier = requireString(entry, "tier", routeContext);
		if (!MODEL_TIERS.includes(tier as (typeof MODEL_TIERS)[number])) {
			throw new EvaluationManifestError("evaluation.invalid_manifest", `${routeContext}.tier is unsupported`);
		}
		const minimumCount = entry.minimumCount ?? 1;
		if (typeof minimumCount !== "number" || !Number.isInteger(minimumCount) || minimumCount < 1) {
			throw new EvaluationManifestError(
				"evaluation.invalid_manifest",
				`${routeContext}.minimumCount must be a positive integer`,
			);
		}
		return { role: role as ModelRouteRole, tier: tier as EvaluationExpectedModelRoute["tier"], minimumCount };
	});
}

function parseTaskSource(value: unknown, context: string): EvaluationTaskSource {
	if (!isRecord(value)) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context}.source must be an object`);
	}
	return {
		dataset: requireString(value, "dataset", `${context}.source`),
		repository: requireString(value, "repository", `${context}.source`),
		revision: requireString(value, "revision", `${context}.source`),
		taskId: requireString(value, "taskId", `${context}.source`),
		license: requireString(value, "license", `${context}.source`),
		adaptation: requireString(value, "adaptation", `${context}.source`),
	};
}

function parseLocalRuntime(value: unknown, context: string): EvaluationLocalRuntime {
	if (!isRecord(value)) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context}.localRuntime must be an object`);
	}
	return {
		executable: requireString(value, "executable", `${context}.localRuntime`),
		executableBaseline: requireString(value, "executableBaseline", `${context}.localRuntime`),
		nodeModules: requireString(value, "nodeModules", `${context}.localRuntime`),
		nodeModulesBaseline: requireString(value, "nodeModulesBaseline", `${context}.localRuntime`),
	};
}

function parseTask(value: unknown, index: number): EvaluationTask {
	const context = `tasks[${index}]`;
	if (!isRecord(value)) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context} must be an object`);
	}
	const difficulty = value.difficulty;
	if (
		difficulty !== undefined &&
		(typeof difficulty !== "string" ||
			!EVALUATION_DIFFICULTIES.includes(difficulty as (typeof EVALUATION_DIFFICULTIES)[number]))
	) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context}.difficulty is unsupported`);
	}
	const expectedStrategy = value.expectedStrategy;
	if (
		expectedStrategy !== undefined &&
		(typeof expectedStrategy !== "string" ||
			!EVALUATION_STRATEGIES.includes(expectedStrategy as (typeof EVALUATION_STRATEGIES)[number]))
	) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context}.expectedStrategy is unsupported`);
	}
	return {
		id: requireString(value, "id", context),
		title: requireString(value, "title", context),
		repositoryFixture: requireString(value, "repositoryFixture", context),
		repositoryBaseline: requireString(value, "repositoryBaseline", context),
		prompt: requireString(value, "prompt", context),
		promptVersion: requireString(value, "promptVersion", context),
		verificationCommands: requireStrings(value, "verificationCommands", context),
		protectedPaths: requireProtectedPaths(value, context),
		successCriteria: requireStrings(value, "successCriteria", context),
		expectedReviewerFindings: requireStrings(value, "expectedReviewerFindings", context),
		budget: parseBudget(value.budget, context),
		...(difficulty ? { difficulty: difficulty as EvaluationTask["difficulty"] } : {}),
		...(expectedStrategy ? { expectedStrategy: expectedStrategy as EvaluationTask["expectedStrategy"] } : {}),
		...(value.expectedModelRoutes !== undefined
			? { expectedModelRoutes: parseExpectedModelRoutes(value.expectedModelRoutes, context) }
			: {}),
		...(value.source !== undefined ? { source: parseTaskSource(value.source, context) } : {}),
		...(value.localRuntime !== undefined ? { localRuntime: parseLocalRuntime(value.localRuntime, context) } : {}),
	};
}

export function parseEvaluationTaskSet(value: unknown): EvaluationTaskSet {
	if (!isRecord(value)) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", "Evaluation task set must be an object");
	}
	if (value.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
		throw new EvaluationManifestError(
			"evaluation.unsupported_schema",
			`Unsupported evaluation schema ${String(value.schemaVersion)}`,
		);
	}
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", "Evaluation task set must contain Tasks");
	}
	const tasks = value.tasks.map(parseTask);
	const ids = new Set(tasks.map(({ id }) => id));
	if (ids.size !== tasks.length) {
		throw new EvaluationManifestError("evaluation.duplicate_task", "Evaluation Task IDs must be unique");
	}
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		id: requireString(value, "id", "taskSet"),
		version: requireString(value, "version", "taskSet"),
		tasks,
	};
}
