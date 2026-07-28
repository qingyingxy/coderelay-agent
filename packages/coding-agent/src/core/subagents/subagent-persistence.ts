import type { CustomEntry, SessionManager } from "../session-manager.ts";
import type { AgentInstance, AgentRuntimeEvent, AgentTranscriptEntry, Handoff } from "./types.ts";

export const SUBAGENT_RUNTIME_CUSTOM_TYPE = "subagent-runtime";

export type SubagentPersistenceRecord =
	| {
			readonly kind: "state";
			readonly agent: AgentInstance;
			readonly event: AgentRuntimeEvent;
			readonly handoff?: Handoff;
	  }
	| {
			readonly kind: "transcript";
			readonly entry: AgentTranscriptEntry;
	  };

export interface SubagentPersistence {
	load(): readonly SubagentPersistenceRecord[];
	append(record: SubagentPersistenceRecord): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPersistenceRecord(value: unknown): value is SubagentPersistenceRecord {
	if (!isRecord(value) || (value.kind !== "state" && value.kind !== "transcript")) {
		return false;
	}
	return value.kind === "state" ? isRecord(value.agent) && isRecord(value.event) : isRecord(value.entry);
}

export class SessionSubagentPersistence implements SubagentPersistence {
	readonly #sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">;

	constructor(sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">) {
		this.#sessionManager = sessionManager;
	}

	load(): readonly SubagentPersistenceRecord[] {
		return this.#sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry =>
					entry.type === "custom" && entry.customType === SUBAGENT_RUNTIME_CUSTOM_TYPE,
			)
			.map(({ data }) => data)
			.filter(isPersistenceRecord)
			.map((record) => structuredClone(record));
	}

	append(record: SubagentPersistenceRecord): void {
		this.#sessionManager.appendCustomEntry(SUBAGENT_RUNTIME_CUSTOM_TYPE, structuredClone(record));
	}
}
