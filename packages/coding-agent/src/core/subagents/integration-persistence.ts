import type { CustomEntry, SessionManager } from "../session-manager.ts";
import type { IntegrationPersistenceRecord, MultiWriterIntegrationPersistence } from "./multi-writer-integration.ts";

export const MULTI_WRITER_INTEGRATION_CUSTOM_TYPE = "multi-writer-integration";
export const MULTI_WRITER_INTEGRATION_SCHEMA_VERSION = 1;

interface IntegrationPersistenceEnvelope {
	readonly schemaVersion: typeof MULTI_WRITER_INTEGRATION_SCHEMA_VERSION;
	readonly record: IntegrationPersistenceRecord;
}

export class IntegrationPersistenceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "IntegrationPersistenceError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isIntegrationRecord(value: unknown): value is IntegrationPersistenceRecord {
	if (!isRecord(value)) {
		return false;
	}
	if (value.kind === "attempt") {
		return isRecord(value.attempt) && typeof value.attempt.id === "string";
	}
	if (value.kind === "conflict") {
		return isRecord(value.conflict) && typeof value.conflict.id === "string";
	}
	return false;
}

export class SessionMultiWriterIntegrationPersistence implements MultiWriterIntegrationPersistence {
	readonly #sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">;

	constructor(sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">) {
		this.#sessionManager = sessionManager;
	}

	load(): readonly IntegrationPersistenceRecord[] {
		return this.#sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry =>
					entry.type === "custom" && entry.customType === MULTI_WRITER_INTEGRATION_CUSTOM_TYPE,
			)
			.map((entry) => {
				if (
					!isRecord(entry.data) ||
					entry.data.schemaVersion !== MULTI_WRITER_INTEGRATION_SCHEMA_VERSION ||
					!isIntegrationRecord(entry.data.record)
				) {
					throw new IntegrationPersistenceError(
						"integration_persistence.corrupt_record",
						`Integration persistence entry ${entry.id} is invalid`,
					);
				}
				return structuredClone(entry.data.record);
			});
	}

	append(record: IntegrationPersistenceRecord): void {
		const envelope: IntegrationPersistenceEnvelope = {
			schemaVersion: MULTI_WRITER_INTEGRATION_SCHEMA_VERSION,
			record: structuredClone(record),
		};
		this.#sessionManager.appendCustomEntry(MULTI_WRITER_INTEGRATION_CUSTOM_TYPE, envelope);
	}
}
