import type { SessionEntry } from "./session-manager.ts";

export const MEMORY_NOTE_CUSTOM_TYPE = "memory-note";
export const MEMORY_NOTE_CATEGORIES = ["decision", "discovery", "preference", "constraint", "open_question"] as const;

export type MemoryNoteCategory = (typeof MEMORY_NOTE_CATEGORIES)[number];
export type MemoryNoteOperation = "upsert" | "archive";

export interface MemoryNoteEntryData {
	readonly schemaVersion: 1;
	readonly noteId: string;
	readonly operation: MemoryNoteOperation;
	readonly category: MemoryNoteCategory;
	readonly content: string;
	readonly workflowId?: string;
	readonly taskId?: string;
	readonly sourceEntryIds: readonly string[];
	readonly createdAt: string;
}

export interface MemoryNote {
	readonly noteId: string;
	readonly entryId: string;
	readonly category: MemoryNoteCategory;
	readonly content: string;
	readonly workflowId?: string;
	readonly taskId?: string;
	readonly sourceEntryIds: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface MemoryNoteUpsertInput {
	readonly noteId?: string;
	readonly category: MemoryNoteCategory;
	readonly content: string;
	readonly workflowId?: string;
	readonly taskId?: string;
	readonly sourceEntryIds?: readonly string[];
}

export interface MemoryNotesHint {
	readonly content: string;
	readonly noteEntryIds: readonly string[];
	readonly truncated: boolean;
}

export interface MemoryNotesListResult {
	readonly schemaVersion: 1;
	readonly action: "list";
	readonly notes: readonly MemoryNote[];
	readonly truncated: boolean;
}

export interface MemoryNoteChangeResult {
	readonly schemaVersion: 1;
	readonly action: "upsert" | "archive";
	readonly note: MemoryNote;
}

interface MemoryNoteState {
	readonly note: MemoryNote;
	readonly active: boolean;
}

export class MemoryNoteValidationError extends Error {
	readonly entryId?: string;

	constructor(message: string, entryId?: string) {
		super(entryId ? `Invalid memory note Entry ${entryId}: ${message}` : `Invalid memory note: ${message}`);
		this.name = "MemoryNoteValidationError";
		this.entryId = entryId;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isValidNoteId(value: string): boolean {
	return value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

function assertOptionalId(value: string | undefined, field: "workflowId" | "taskId"): void {
	if (value !== undefined && (!isNonEmptyString(value) || value.length > 256)) {
		throw new MemoryNoteValidationError(`${field} must be a non-empty string of at most 256 characters`);
	}
}

export function assertValidMemoryNoteEntryData(value: unknown, entryId?: string): asserts value is MemoryNoteEntryData {
	if (!isRecord(value)) throw new MemoryNoteValidationError("data must be an object", entryId);
	if (value.schemaVersion !== 1) throw new MemoryNoteValidationError("schemaVersion must be 1", entryId);
	if (!isNonEmptyString(value.noteId) || !isValidNoteId(value.noteId)) {
		throw new MemoryNoteValidationError("noteId is invalid", entryId);
	}
	if (value.operation !== "upsert" && value.operation !== "archive") {
		throw new MemoryNoteValidationError("operation must be upsert or archive", entryId);
	}
	if (!MEMORY_NOTE_CATEGORIES.includes(value.category as MemoryNoteCategory)) {
		throw new MemoryNoteValidationError("category is not supported", entryId);
	}
	if (!isNonEmptyString(value.content)) throw new MemoryNoteValidationError("content must not be empty", entryId);
	assertOptionalId(typeof value.workflowId === "string" ? value.workflowId : undefined, "workflowId");
	if (value.workflowId !== undefined && typeof value.workflowId !== "string") {
		throw new MemoryNoteValidationError("workflowId must be a string", entryId);
	}
	assertOptionalId(typeof value.taskId === "string" ? value.taskId : undefined, "taskId");
	if (value.taskId !== undefined && typeof value.taskId !== "string") {
		throw new MemoryNoteValidationError("taskId must be a string", entryId);
	}
	if (
		!Array.isArray(value.sourceEntryIds) ||
		!value.sourceEntryIds.every((sourceEntryId) => isNonEmptyString(sourceEntryId) && sourceEntryId.length <= 128)
	) {
		throw new MemoryNoteValidationError("sourceEntryIds must contain only valid Entry IDs", entryId);
	}
	if (new Set(value.sourceEntryIds).size !== value.sourceEntryIds.length) {
		throw new MemoryNoteValidationError("sourceEntryIds must not contain duplicates", entryId);
	}
	if (!isNonEmptyString(value.createdAt) || Number.isNaN(Date.parse(value.createdAt))) {
		throw new MemoryNoteValidationError("createdAt must be an ISO timestamp", entryId);
	}
}

function replayMemoryNoteStates(branch: readonly SessionEntry[]): Map<string, MemoryNoteState> {
	const seenEntryIds = new Set<string>();
	const states = new Map<string, MemoryNoteState>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_NOTE_CUSTOM_TYPE) {
			seenEntryIds.add(entry.id);
			continue;
		}
		assertValidMemoryNoteEntryData(entry.data, entry.id);
		for (const sourceEntryId of entry.data.sourceEntryIds) {
			if (!seenEntryIds.has(sourceEntryId)) {
				throw new MemoryNoteValidationError(
					`source Entry ${sourceEntryId} does not precede the note on the current branch`,
					entry.id,
				);
			}
		}

		const previous = states.get(entry.data.noteId);
		if (previous && previous.note.createdAt !== entry.data.createdAt) {
			throw new MemoryNoteValidationError("createdAt changed across operations", entry.id);
		}
		if (entry.data.operation === "archive" && !previous?.active) {
			throw new MemoryNoteValidationError("archive does not reference an active note", entry.id);
		}
		states.set(entry.data.noteId, {
			note: {
				noteId: entry.data.noteId,
				entryId: entry.id,
				category: entry.data.category,
				content: entry.data.content,
				...(entry.data.workflowId ? { workflowId: entry.data.workflowId } : {}),
				...(entry.data.taskId ? { taskId: entry.data.taskId } : {}),
				sourceEntryIds: [...entry.data.sourceEntryIds],
				createdAt: entry.data.createdAt,
				updatedAt: entry.timestamp,
			},
			active: entry.data.operation === "upsert",
		});
		seenEntryIds.add(entry.id);
	}
	return states;
}

export function getMemoryNotes(branch: readonly SessionEntry[]): MemoryNote[] {
	return [...replayMemoryNoteStates(branch).values()]
		.filter(({ active }) => active)
		.map(({ note }) => note)
		.sort((left, right) => left.noteId.localeCompare(right.noteId));
}

export function getLatestMemoryNote(branch: readonly SessionEntry[], noteId: string): MemoryNote | undefined {
	return replayMemoryNoteStates(branch).get(noteId)?.note;
}

export function prepareMemoryNoteUpsert(
	branch: readonly SessionEntry[],
	input: MemoryNoteUpsertInput,
	maxContentBytes: number,
	createNoteId: () => string,
	now: () => string = () => new Date().toISOString(),
): MemoryNoteEntryData {
	if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) {
		throw new MemoryNoteValidationError("maxContentBytes must be a positive integer");
	}
	const content = input.content.trim();
	if (!content) throw new MemoryNoteValidationError("content must not be empty");
	if (Buffer.byteLength(content, "utf8") > maxContentBytes) {
		throw new MemoryNoteValidationError(`content exceeds the ${maxContentBytes}-byte limit`);
	}
	const noteId = input.noteId ?? createNoteId();
	if (!isValidNoteId(noteId)) throw new MemoryNoteValidationError("noteId is invalid");
	if (!MEMORY_NOTE_CATEGORIES.includes(input.category)) {
		throw new MemoryNoteValidationError("category is not supported");
	}
	assertOptionalId(input.workflowId, "workflowId");
	assertOptionalId(input.taskId, "taskId");
	const sourceEntryIds = [...(input.sourceEntryIds ?? [])];
	if (new Set(sourceEntryIds).size !== sourceEntryIds.length) {
		throw new MemoryNoteValidationError("sourceEntryIds must not contain duplicates");
	}
	const branchEntryIds = new Set(branch.map((entry) => entry.id));
	for (const sourceEntryId of sourceEntryIds) {
		if (!branchEntryIds.has(sourceEntryId)) {
			throw new MemoryNoteValidationError(`source Entry ${sourceEntryId} is not on the current branch`);
		}
	}
	const previous = replayMemoryNoteStates(branch).get(noteId);
	const createdAt = previous?.note.createdAt ?? now();
	const data: MemoryNoteEntryData = {
		schemaVersion: 1,
		noteId,
		operation: "upsert",
		category: input.category,
		content,
		...(input.workflowId ? { workflowId: input.workflowId } : {}),
		...(input.taskId ? { taskId: input.taskId } : {}),
		sourceEntryIds,
		createdAt,
	};
	assertValidMemoryNoteEntryData(data);
	return data;
}

export function prepareMemoryNoteArchive(branch: readonly SessionEntry[], noteId: string): MemoryNoteEntryData {
	if (!isValidNoteId(noteId)) throw new MemoryNoteValidationError("noteId is invalid");
	const previous = replayMemoryNoteStates(branch).get(noteId);
	if (!previous?.active) throw new MemoryNoteValidationError(`active note ${noteId} does not exist`);
	return {
		schemaVersion: 1,
		noteId,
		operation: "archive",
		category: previous.note.category,
		content: previous.note.content,
		...(previous.note.workflowId ? { workflowId: previous.note.workflowId } : {}),
		...(previous.note.taskId ? { taskId: previous.note.taskId } : {}),
		sourceEntryIds: [...previous.note.sourceEntryIds],
		createdAt: previous.note.createdAt,
	};
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function listMemoryNotes(branch: readonly SessionEntry[], maxBytes: number): MemoryNotesListResult {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) {
		throw new Error("notes result maxBytes must be an integer of at least 512");
	}
	const notes = [...getMemoryNotes(branch)].sort(
		(left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.noteId.localeCompare(right.noteId),
	);
	const selected: MemoryNote[] = [];
	for (const note of notes) {
		const proposed: MemoryNotesListResult = {
			schemaVersion: 1,
			action: "list",
			notes: [...selected, note],
			truncated: selected.length + 1 < notes.length,
		};
		if (serializedBytes(proposed) > maxBytes) break;
		selected.push(note);
	}
	return {
		schemaVersion: 1,
		action: "list",
		notes: selected,
		truncated: selected.length < notes.length,
	};
}

function notePriority(note: MemoryNote, workflowId: string | undefined): number {
	if (note.category === "constraint" || note.category === "preference") return 0;
	if (workflowId && note.workflowId === workflowId && note.category === "decision") return 1;
	if (note.category === "open_question") return 2;
	if (note.category === "discovery") return 3;
	return 4;
}

function truncateUtf8(value: string, maxBytes: number): { readonly content: string; readonly truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { content: value, truncated: false };
	let content = "";
	for (const character of value) {
		if (Buffer.byteLength(`${content}${character}`, "utf8") > maxBytes) break;
		content += character;
	}
	return { content, truncated: true };
}

export function buildMemoryNotesHint(
	branch: readonly SessionEntry[],
	maxBytes: number,
	workflowId?: string,
): MemoryNotesHint {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error("notes hint maxBytes must be a positive integer");
	}
	const notes = getMemoryNotes(branch).sort(
		(left, right) =>
			notePriority(left, workflowId) - notePriority(right, workflowId) ||
			right.updatedAt.localeCompare(left.updatedAt) ||
			left.noteId.localeCompare(right.noteId),
	);
	const header = "Persisted Notes (non-authoritative; Workflow Snapshot wins on conflicts):";
	if (notes.length === 0) {
		const empty = truncateUtf8(`${header}\n- none`, maxBytes);
		return {
			content: empty.truncated ? truncateUtf8("[notes truncated]", maxBytes).content : empty.content,
			noteEntryIds: [],
			truncated: empty.truncated,
		};
	}

	const marker = "- [notes truncated]";
	if (Buffer.byteLength(`${header}\n${marker}`, "utf8") > maxBytes) {
		return { content: truncateUtf8("[notes truncated]", maxBytes).content, noteEntryIds: [], truncated: true };
	}
	let content = header;
	const noteEntryIds: string[] = [];
	for (let index = 0; index < notes.length; index++) {
		const note = notes[index];
		const line = `- [${note.category}] ${note.content} (noteId: ${note.noteId})`;
		const candidate = `${content}\n${line}`;
		const hasMoreNotes = index + 1 < notes.length;
		const reservedCandidate = hasMoreNotes ? `${candidate}\n${marker}` : candidate;
		if (Buffer.byteLength(reservedCandidate, "utf8") <= maxBytes) {
			content = candidate;
			noteEntryIds.push(note.entryId);
			continue;
		}

		const prefix = `${content}\n`;
		const markerSuffix = `\n${marker}`;
		const remainingBytes = maxBytes - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(markerSuffix, "utf8");
		const partial = remainingBytes > 0 ? truncateUtf8(line, remainingBytes).content : "";
		if (partial) {
			content = `${prefix}${partial}`;
			noteEntryIds.push(note.entryId);
		}
		return { content: `${content}${markerSuffix}`, noteEntryIds, truncated: true };
	}
	return { content, noteEntryIds, truncated: false };
}
