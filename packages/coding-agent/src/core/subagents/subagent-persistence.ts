import type { CustomEntry, SessionManager } from "../session-manager.ts";
import { SecretRedactor } from "./subagent-retention.ts";
import type { AgentInstance, AgentRuntimeEvent, AgentTranscriptEntry, Handoff, SpawnSubagentInput } from "./types.ts";

export const SUBAGENT_RUNTIME_CUSTOM_TYPE = "subagent-runtime";
export const SUBAGENT_PERSISTENCE_SCHEMA_VERSION = 2;
export const SUBAGENT_CHECKPOINT_SCHEMA_VERSION = 1;

export interface SubagentCheckpoint {
	readonly schemaVersion: typeof SUBAGENT_CHECKPOINT_SCHEMA_VERSION;
	readonly createdAt: string;
	readonly agents: readonly AgentInstance[];
	readonly handoffs: readonly Handoff[];
	readonly events: readonly AgentRuntimeEvent[];
	readonly transcripts: readonly AgentTranscriptEntry[];
	readonly spawnInputs: readonly {
		readonly agentId: string;
		readonly input: SpawnSubagentInput;
	}[];
}

export type SubagentPersistenceRecord =
	| {
			readonly kind: "state";
			readonly agent: AgentInstance;
			readonly event: AgentRuntimeEvent;
			readonly handoff?: Handoff;
			readonly spawnInput?: SpawnSubagentInput;
	  }
	| {
			readonly kind: "transcript";
			readonly entry: AgentTranscriptEntry;
	  }
	| {
			readonly kind: "checkpoint";
			readonly checkpoint: SubagentCheckpoint;
	  };

interface SubagentPersistenceEnvelope {
	readonly schemaVersion: typeof SUBAGENT_PERSISTENCE_SCHEMA_VERSION;
	readonly record: SubagentPersistenceRecord;
}

export interface SubagentPersistence {
	load(): readonly SubagentPersistenceRecord[];
	append(record: SubagentPersistenceRecord): void;
	compact?(checkpoint: SubagentCheckpoint): void;
}

export class SubagentPersistenceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SubagentPersistenceError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAgent(value: unknown): value is AgentInstance {
	return isRecord(value) && typeof value.id === "string" && typeof value.workflowId === "string";
}

function isEvent(value: unknown): value is AgentRuntimeEvent {
	return (
		isRecord(value) &&
		typeof value.sequence === "number" &&
		typeof value.agentId === "string" &&
		typeof value.eventName === "string"
	);
}

function isTranscript(value: unknown): value is AgentTranscriptEntry {
	return (
		isRecord(value) &&
		typeof value.sequence === "number" &&
		typeof value.agentId === "string" &&
		typeof value.type === "string" &&
		typeof value.text === "string"
	);
}

function isHandoff(value: unknown): value is Handoff {
	return isRecord(value) && typeof value.id === "string" && typeof value.agentId === "string";
}

function isSpawnInput(value: unknown): value is SpawnSubagentInput {
	return (
		isRecord(value) &&
		typeof value.workflowId === "string" &&
		typeof value.taskId === "string" &&
		typeof value.attemptId === "string" &&
		typeof value.cwd === "string" &&
		isRecord(value.profile)
	);
}

function isCheckpoint(value: unknown): value is SubagentCheckpoint {
	if (
		!isRecord(value) ||
		value.schemaVersion !== SUBAGENT_CHECKPOINT_SCHEMA_VERSION ||
		typeof value.createdAt !== "string" ||
		!Array.isArray(value.agents) ||
		!Array.isArray(value.handoffs) ||
		!Array.isArray(value.events) ||
		!Array.isArray(value.transcripts) ||
		!Array.isArray(value.spawnInputs)
	) {
		return false;
	}
	return (
		value.agents.every(isAgent) &&
		value.handoffs.every(isHandoff) &&
		value.events.every(isEvent) &&
		value.transcripts.every(isTranscript) &&
		value.spawnInputs.every(
			(entry) => isRecord(entry) && typeof entry.agentId === "string" && isSpawnInput(entry.input),
		)
	);
}

function isPersistenceRecord(value: unknown): value is SubagentPersistenceRecord {
	if (!isRecord(value) || typeof value.kind !== "string") {
		return false;
	}
	switch (value.kind) {
		case "state":
			return (
				isAgent(value.agent) &&
				isEvent(value.event) &&
				(value.handoff === undefined || isHandoff(value.handoff)) &&
				(value.spawnInput === undefined || isSpawnInput(value.spawnInput))
			);
		case "transcript":
			return isTranscript(value.entry);
		case "checkpoint":
			return isCheckpoint(value.checkpoint);
		default:
			return false;
	}
}

function parsePersistenceEntry(entry: CustomEntry): SubagentPersistenceRecord {
	const data = entry.data;
	if (isRecord(data) && "schemaVersion" in data) {
		if (data.schemaVersion !== SUBAGENT_PERSISTENCE_SCHEMA_VERSION) {
			throw new SubagentPersistenceError(
				"subagent_persistence.unknown_schema",
				`Unsupported Subagent persistence schema ${String(data.schemaVersion)}`,
			);
		}
		if (!isPersistenceRecord(data.record)) {
			throw new SubagentPersistenceError(
				"subagent_persistence.corrupt_record",
				`Subagent persistence entry ${entry.id} is invalid`,
			);
		}
		return structuredClone(data.record);
	}
	if (isPersistenceRecord(data)) {
		return structuredClone(data);
	}
	throw new SubagentPersistenceError(
		"subagent_persistence.corrupt_record",
		`Legacy Subagent persistence entry ${entry.id} is invalid`,
	);
}

export interface SessionSubagentPersistenceOptions {
	readonly redactor?: SecretRedactor;
}

export class SessionSubagentPersistence implements SubagentPersistence {
	readonly #sessionManager: Pick<SessionManager, "appendCustomEntry" | "compactCustomEntries" | "getBranch">;
	readonly #redactor: SecretRedactor;

	constructor(
		sessionManager: Pick<SessionManager, "appendCustomEntry" | "compactCustomEntries" | "getBranch">,
		options: SessionSubagentPersistenceOptions = {},
	) {
		this.#sessionManager = sessionManager;
		this.#redactor = options.redactor ?? new SecretRedactor();
	}

	load(): readonly SubagentPersistenceRecord[] {
		const records = this.#sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry =>
					entry.type === "custom" && entry.customType === SUBAGENT_RUNTIME_CUSTOM_TYPE,
			)
			.map(parsePersistenceEntry);
		let lastCheckpoint = -1;
		for (let index = records.length - 1; index >= 0; index--) {
			if (records[index]?.kind === "checkpoint") {
				lastCheckpoint = index;
				break;
			}
		}
		return this.#redactor.redact(structuredClone(lastCheckpoint < 0 ? records : records.slice(lastCheckpoint)));
	}

	append(record: SubagentPersistenceRecord): void {
		this.#append(record);
	}

	compact(checkpoint: SubagentCheckpoint): void {
		const checkpointId = this.#append({ kind: "checkpoint", checkpoint });
		this.#sessionManager.compactCustomEntries(SUBAGENT_RUNTIME_CUSTOM_TYPE, new Set([checkpointId]));
	}

	#append(record: SubagentPersistenceRecord): string {
		const envelope: SubagentPersistenceEnvelope = {
			schemaVersion: SUBAGENT_PERSISTENCE_SCHEMA_VERSION,
			record: this.#redactor.redact(record),
		};
		return this.#sessionManager.appendCustomEntry(SUBAGENT_RUNTIME_CUSTOM_TYPE, envelope);
	}
}
