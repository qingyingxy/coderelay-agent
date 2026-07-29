import type { CustomEntry, SessionManager } from "../session-manager.ts";
import type { TeamAuditEvent } from "./team-types.ts";

export const AGENT_TEAM_CUSTOM_TYPE = "agent-team";
export const AGENT_TEAM_PERSISTENCE_SCHEMA_VERSION = 1;

interface AgentTeamPersistenceEnvelope {
	readonly schemaVersion: typeof AGENT_TEAM_PERSISTENCE_SCHEMA_VERSION;
	readonly event: TeamAuditEvent;
}

export interface AgentTeamPersistence {
	load(): readonly TeamAuditEvent[];
	append(event: TeamAuditEvent): void;
}

export class AgentTeamPersistenceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AgentTeamPersistenceError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTeamAuditEvent(value: unknown): value is TeamAuditEvent {
	if (
		!isRecord(value) ||
		typeof value.sequence !== "number" ||
		typeof value.workflowId !== "string" ||
		typeof value.type !== "string" ||
		typeof value.occurredAt !== "string"
	) {
		return false;
	}
	return value.type === "message.sent" ? isRecord(value.message) : isRecord(value.proposal);
}

function parseEntry(entry: CustomEntry): TeamAuditEvent {
	if (
		!isRecord(entry.data) ||
		entry.data.schemaVersion !== AGENT_TEAM_PERSISTENCE_SCHEMA_VERSION ||
		!isTeamAuditEvent(entry.data.event)
	) {
		throw new AgentTeamPersistenceError(
			"agent_team_persistence.corrupt_record",
			`Agent Team persistence entry ${entry.id} is invalid`,
		);
	}
	return structuredClone(entry.data.event);
}

export class SessionAgentTeamPersistence implements AgentTeamPersistence {
	readonly #sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">;

	constructor(sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">) {
		this.#sessionManager = sessionManager;
	}

	load(): readonly TeamAuditEvent[] {
		return this.#sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === AGENT_TEAM_CUSTOM_TYPE,
			)
			.map(parseEntry);
	}

	append(event: TeamAuditEvent): void {
		const envelope: AgentTeamPersistenceEnvelope = {
			schemaVersion: AGENT_TEAM_PERSISTENCE_SCHEMA_VERSION,
			event: structuredClone(event),
		};
		this.#sessionManager.appendCustomEntry(AGENT_TEAM_CUSTOM_TYPE, envelope);
	}
}
