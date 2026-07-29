import {
	EVALUATION_SCHEMA_VERSION,
	type EvaluationBudget,
	type EvaluationTask,
	type EvaluationTaskSet,
} from "./types.ts";

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

function parseTask(value: unknown, index: number): EvaluationTask {
	const context = `tasks[${index}]`;
	if (!isRecord(value)) {
		throw new EvaluationManifestError("evaluation.invalid_manifest", `${context} must be an object`);
	}
	return {
		id: requireString(value, "id", context),
		title: requireString(value, "title", context),
		repositoryFixture: requireString(value, "repositoryFixture", context),
		repositoryBaseline: requireString(value, "repositoryBaseline", context),
		prompt: requireString(value, "prompt", context),
		promptVersion: requireString(value, "promptVersion", context),
		verificationCommands: requireStrings(value, "verificationCommands", context),
		successCriteria: requireStrings(value, "successCriteria", context),
		expectedReviewerFindings: requireStrings(value, "expectedReviewerFindings", context),
		budget: parseBudget(value.budget, context),
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
