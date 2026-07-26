import type { CustomEntry, SessionManager } from "../session-manager.ts";
import type { AnyWorkflowEvent, WorkflowEventActorKind, WorkflowEventBatch } from "./events.ts";
import { isWorkflowEventType, validateWorkflowEventBatch } from "./events.ts";
import type { DomainViolation } from "./transitions.ts";
import type { CommandId, WorkflowId } from "./types.ts";

export const WORKFLOW_EVENT_BATCH_CUSTOM_TYPE = "workflow-event-batch";

const PERSISTED_BATCH = Symbol("persisted-workflow-event-batch");
const ISSUED_PERSISTED_BATCHES = new WeakSet<object>();
const ACTOR_KINDS: ReadonlySet<string> = new Set<WorkflowEventActorKind>([
	"user",
	"controller",
	"agent",
	"job",
	"system",
]);

export interface PersistedWorkflowEventBatch {
	readonly [PERSISTED_BATCH]: true;
	readonly sessionEntryId: string;
	readonly batch: WorkflowEventBatch;
}

export type WorkflowEventLogSession = Pick<SessionManager, "appendCustomEntry" | "getBranch">;

interface RecordedBatch {
	readonly sessionEntryId: string;
	readonly batch: WorkflowEventBatch;
}

export class WorkflowEventLogError extends Error {
	readonly violations: readonly DomainViolation[];

	constructor(message: string, violations: readonly DomainViolation[]) {
		super(message);
		this.name = "WorkflowEventLogError";
		this.violations = violations;
	}
}

function violation(code: string, message: string): DomainViolation {
	return { code, message };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasEventEnvelope(value: unknown): value is AnyWorkflowEvent {
	if (!isRecord(value) || !isWorkflowEventType(value.eventType) || !isRecord(value.actor)) {
		return false;
	}
	return (
		typeof value.schemaVersion === "number" &&
		typeof value.eventId === "string" &&
		typeof value.workflowId === "string" &&
		typeof value.sequence === "number" &&
		typeof value.entityType === "string" &&
		typeof value.entityId === "string" &&
		typeof value.entityRevision === "number" &&
		typeof value.occurredAt === "string" &&
		typeof value.actor.kind === "string" &&
		ACTOR_KINDS.has(value.actor.kind) &&
		(value.actor.id === undefined || typeof value.actor.id === "string") &&
		typeof value.commandId === "string" &&
		typeof value.correlationId === "string" &&
		(value.causationId === undefined || typeof value.causationId === "string") &&
		isRecord(value.payload)
	);
}

function hasBatchEnvelope(value: unknown): value is WorkflowEventBatch {
	return (
		isRecord(value) &&
		typeof value.schemaVersion === "number" &&
		typeof value.batchId === "string" &&
		typeof value.workflowId === "string" &&
		typeof value.commandId === "string" &&
		typeof value.correlationId === "string" &&
		typeof value.expectedLastSequence === "number" &&
		Array.isArray(value.events) &&
		value.events.every(hasEventEnvelope)
	);
}

function markPersisted(sessionEntryId: string, batch: WorkflowEventBatch): PersistedWorkflowEventBatch {
	const persisted: PersistedWorkflowEventBatch = Object.freeze({
		[PERSISTED_BATCH]: true as const,
		sessionEntryId,
		batch: deepFreeze(structuredClone(batch)),
	});
	ISSUED_PERSISTED_BATCHES.add(persisted);
	return persisted;
}

export function isPersistedWorkflowEventBatch(value: unknown): value is PersistedWorkflowEventBatch {
	return (
		typeof value === "object" &&
		value !== null &&
		ISSUED_PERSISTED_BATCHES.has(value) &&
		PERSISTED_BATCH in value &&
		(value as PersistedWorkflowEventBatch)[PERSISTED_BATCH] === true
	);
}

function isEntityCreationEvent(event: AnyWorkflowEvent): boolean {
	return (
		event.eventType === "workflow.created" ||
		event.eventType === "task.created" ||
		event.eventType === "attempt.created" ||
		event.eventType === "verification.started"
	);
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

function validateHistory(batches: readonly RecordedBatch[]): readonly DomainViolation[] {
	const violations: DomainViolation[] = [];
	const batchIds = new Set<string>();
	const eventIds = new Set<string>();
	const commandIds = new Set<string>();
	const lastSequences = new Map<WorkflowId, number>();
	const entityRevisions = new Map<string, number>();

	for (const { batch } of batches) {
		const expectedLastSequence = lastSequences.get(batch.workflowId) ?? 0;
		if (batch.expectedLastSequence !== expectedLastSequence) {
			violations.push(
				violation(
					"event_log.sequence_conflict",
					`Batch ${batch.batchId} expected sequence ${batch.expectedLastSequence}, current is ${expectedLastSequence}`,
				),
			);
		}
		if (batchIds.has(batch.batchId)) {
			violations.push(violation("event_log.duplicate_batch", `Batch id ${batch.batchId} appears more than once`));
		}
		batchIds.add(batch.batchId);

		const commandKey = `${batch.workflowId}:${batch.commandId}`;
		if (commandIds.has(commandKey)) {
			violations.push(
				violation(
					"event_log.duplicate_command",
					`Command ${batch.commandId} appears more than once for workflow ${batch.workflowId}`,
				),
			);
		}
		commandIds.add(commandKey);

		for (const event of batch.events) {
			if (eventIds.has(event.eventId)) {
				violations.push(
					violation("event_log.duplicate_event", `Event id ${event.eventId} appears in multiple batches`),
				);
			}
			eventIds.add(event.eventId);

			const entityKey = `${event.workflowId}:${event.entityType}:${event.entityId}`;
			const previousRevision = entityRevisions.get(entityKey);
			if (previousRevision === undefined) {
				if (!isEntityCreationEvent(event)) {
					violations.push(
						violation(
							"event_log.missing_entity_creation",
							`Entity ${entityKey} is updated before its creation event`,
						),
					);
				}
			} else if (event.entityRevision !== previousRevision + 1) {
				violations.push(
					violation(
						"event_log.entity_revision_conflict",
						`Entity ${entityKey} revision must increment from ${previousRevision} to ${previousRevision + 1}`,
					),
				);
			}
			entityRevisions.set(entityKey, event.entityRevision);
		}

		const lastEvent = batch.events.at(-1);
		if (lastEvent) {
			lastSequences.set(batch.workflowId, lastEvent.sequence);
		}
	}

	return violations;
}

function decodeBatch(entry: CustomEntry<unknown>): RecordedBatch {
	if (!hasBatchEnvelope(entry.data)) {
		throw new WorkflowEventLogError("Invalid workflow event batch data", [
			violation("event_log.invalid_batch_data", `Session entry ${entry.id} does not contain a valid batch envelope`),
		]);
	}

	let violations: readonly DomainViolation[];
	try {
		violations = validateWorkflowEventBatch(entry.data);
	} catch {
		throw new WorkflowEventLogError("Invalid workflow event payload", [
			violation("event_log.invalid_event_payload", `Session entry ${entry.id} contains a malformed event payload`),
		]);
	}
	if (violations.length > 0) {
		throw new WorkflowEventLogError("Invalid workflow event batch", violations);
	}
	return {
		sessionEntryId: entry.id,
		batch: structuredClone(entry.data),
	};
}

export class SessionWorkflowEventLog {
	readonly #session: WorkflowEventLogSession;

	constructor(session: WorkflowEventLogSession) {
		this.#session = session;
	}

	read(workflowId?: WorkflowId): readonly PersistedWorkflowEventBatch[] {
		const recorded = this.#session
			.getBranch()
			.filter(
				(entry): entry is CustomEntry<unknown> =>
					entry.type === "custom" && entry.customType === WORKFLOW_EVENT_BATCH_CUSTOM_TYPE,
			)
			.map(decodeBatch);
		const violations = validateHistory(recorded);
		if (violations.length > 0) {
			throw new WorkflowEventLogError("Workflow event history is inconsistent", violations);
		}

		return recorded
			.filter(({ batch }) => workflowId === undefined || batch.workflowId === workflowId)
			.map(({ sessionEntryId, batch }) => markPersisted(sessionEntryId, batch));
	}

	findByCommand(workflowId: WorkflowId, commandId: CommandId): PersistedWorkflowEventBatch | undefined {
		return this.read(workflowId).find(({ batch }) => batch.commandId === commandId);
	}

	append(batch: WorkflowEventBatch): PersistedWorkflowEventBatch {
		const violations = validateWorkflowEventBatch(batch);
		if (violations.length > 0) {
			throw new WorkflowEventLogError("Cannot append an invalid workflow event batch", violations);
		}

		const current = this.read();
		const existingCommand = current.find(
			(entry) => entry.batch.workflowId === batch.workflowId && entry.batch.commandId === batch.commandId,
		);
		if (existingCommand) {
			return existingCommand;
		}

		const proposed: RecordedBatch = {
			sessionEntryId: "<pending>",
			batch,
		};
		const historyViolations = validateHistory([
			...current.map(({ sessionEntryId, batch: persistedBatch }) => ({
				sessionEntryId,
				batch: persistedBatch,
			})),
			proposed,
		]);
		if (historyViolations.length > 0) {
			throw new WorkflowEventLogError("Workflow event batch conflicts with current history", historyViolations);
		}

		const storedBatch = structuredClone(batch);
		const sessionEntryId = this.#session.appendCustomEntry(WORKFLOW_EVENT_BATCH_CUSTOM_TYPE, storedBatch);
		return markPersisted(sessionEntryId, storedBatch);
	}
}
