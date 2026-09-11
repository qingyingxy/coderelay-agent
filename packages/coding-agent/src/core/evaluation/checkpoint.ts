import { EVALUATION_ESCALATION_POLICY_VERSION } from "./escalation-policy.ts";
import {
	EVALUATION_PROTOCOL_STATUSES,
	EVALUATION_PROTOCOL_VERSION,
	EVALUATION_SCHEMA_VERSION,
	type EvaluationCheckpoint,
	type EvaluationRunRecord,
} from "./types.ts";

export class EvaluationCheckpointError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EvaluationCheckpointError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEvaluationCheckpoint(value: unknown, configurationDigest: string): EvaluationCheckpoint {
	if (!isRecord(value) || value.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
		throw new EvaluationCheckpointError(
			"evaluation.checkpoint_schema_mismatch",
			`Checkpoint schema must be ${EVALUATION_SCHEMA_VERSION}`,
		);
	}
	if (value.configurationDigest !== configurationDigest) {
		throw new EvaluationCheckpointError(
			"evaluation.checkpoint_configuration_mismatch",
			"Checkpoint does not match the current Task Set, Model, strategies, repetitions, or routing configuration",
		);
	}
	if (!Array.isArray(value.runs)) {
		throw new EvaluationCheckpointError("evaluation.invalid_checkpoint", "Checkpoint runs must be an array");
	}
	const runKeys = new Set<string>();
	for (const [index, run] of value.runs.entries()) {
		if (
			!isRecord(run) ||
			run.schemaVersion !== EVALUATION_SCHEMA_VERSION ||
			typeof run.taskId !== "string" ||
			typeof run.strategy !== "string" ||
			!Number.isInteger(run.repetition) ||
			(run.repetition as number) < 1 ||
			typeof run.runConfigurationDigest !== "string" ||
			!isRecord(run.escalationPolicy) ||
			run.escalationPolicy.version !== EVALUATION_ESCALATION_POLICY_VERSION ||
			run.evaluationProtocolVersion !== EVALUATION_PROTOCOL_VERSION ||
			typeof run.protocolStatus !== "string" ||
			!EVALUATION_PROTOCOL_STATUSES.includes(run.protocolStatus as EvaluationRunRecord["protocolStatus"]) ||
			!Array.isArray(run.protocolViolations)
		) {
			throw new EvaluationCheckpointError(
				"evaluation.invalid_checkpoint",
				`Checkpoint run ${index} is missing its schema, Task, strategy, repetition, configuration, or protocol evidence`,
			);
		}
		const key = `${run.strategy}:${run.taskId}:${run.repetition}`;
		if (runKeys.has(key)) {
			throw new EvaluationCheckpointError("evaluation.duplicate_checkpoint_run", `Duplicate checkpoint run ${key}`);
		}
		runKeys.add(key);
	}
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		configurationDigest,
		runs: structuredClone(value.runs) as EvaluationRunRecord[],
	};
}
