import { createHash } from "node:crypto";
import type { SessionEntry } from "./session-manager.ts";

export const DEFAULT_NOTE_CONTENT_MAX_BYTES = 32_768;
const TITLE_MAX_BYTES = 160;

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
	readonly title?: string;
	readonly keywords?: readonly string[];
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
	readonly title: string;
	readonly keywords: readonly string[];
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
	readonly title?: string;
	readonly keywords?: readonly string[];
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
	readonly action: "list" | "search";
	readonly notes: readonly MemoryNoteIndex[];
	readonly truncated: boolean;
	readonly nextCursor?: string;
}

export interface MemoryNoteIndex {
	readonly noteId: string;
	readonly entryId: string;
	readonly title: string;
	readonly category: MemoryNoteCategory;
	readonly updatedAt: string;
	readonly contentBytes: number;
	readonly snippet?: string;
}

export interface MemoryNotesQuery {
	readonly query?: string;
	readonly category?: MemoryNoteCategory;
	readonly workflowId?: string;
	readonly taskId?: string;
	readonly cursor?: string;
}

export interface MemoryNoteReadRequest {
	readonly noteId: string;
	/** Opaque continuation token, bound to the exact note version. */
	readonly cursor?: string;
}

export interface MemoryNoteReadResult {
	readonly schemaVersion: 1;
	readonly action: "read";
	readonly note: MemoryNote;
	readonly truncated: boolean;
	readonly nextCursor?: string;
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
	if (
		value.title !== undefined &&
		(!isNonEmptyString(value.title) ||
			/[\r\n]/.test(value.title) ||
			Buffer.byteLength(value.title, "utf8") > TITLE_MAX_BYTES)
	) {
		throw new MemoryNoteValidationError("title must be a single non-empty line of at most 160 UTF-8 bytes", entryId);
	}
	if (
		value.keywords !== undefined &&
		(!Array.isArray(value.keywords) ||
			value.keywords.length > 16 ||
			!value.keywords.every((keyword) => isNonEmptyString(keyword) && Buffer.byteLength(keyword, "utf8") <= 80))
	) {
		throw new MemoryNoteValidationError(
			"keywords must contain at most 16 non-empty strings of at most 80 UTF-8 bytes",
			entryId,
		);
	}
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
				title: entry.data.title ?? truncateUtf8(entry.data.content.replace(/\s+/g, " "), TITLE_MAX_BYTES).content,
				keywords: [...(entry.data.keywords ?? [])],
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
		title: input.title ?? truncateUtf8(content.replace(/\s+/g, " "), TITLE_MAX_BYTES).content,
		keywords: [...(input.keywords ?? [])],
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
		title: previous.note.title,
		keywords: [...previous.note.keywords],
		...(previous.note.workflowId ? { workflowId: previous.note.workflowId } : {}),
		...(previous.note.taskId ? { taskId: previous.note.taskId } : {}),
		sourceEntryIds: [...previous.note.sourceEntryIds],
		createdAt: previous.note.createdAt,
	};
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function memoryNoteIndex(note: MemoryNote): MemoryNoteIndex {
	return {
		noteId: note.noteId,
		entryId: note.entryId,
		title: note.title,
		category: note.category,
		updatedAt: note.updatedAt,
		contentBytes: Buffer.byteLength(note.content, "utf8"),
	};
}

function recentNotes(branch: readonly SessionEntry[]): MemoryNote[] {
	const order = new Map(branch.map((entry, index) => [entry.id, index]));
	return getMemoryNotes(branch).sort(
		(left, right) =>
			Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
			(order.get(right.entryId) ?? 0) - (order.get(left.entryId) ?? 0),
	);
}

function cursorOffset(cursor: string | undefined, fingerprint: string, length: number): number {
	if (cursor === undefined) return 0;
	const match = /^([a-f0-9]{64}):([1-9][0-9]*)$/.exec(cursor);
	const offset = match ? Number(match[2]) : Number.NaN;
	if (!match || match[1] !== fingerprint || !Number.isSafeInteger(offset) || offset >= length) {
		throw new MemoryNoteValidationError("invalid or stale cursor; restart the query/read without cursor");
	}
	return offset;
}

export function listMemoryNotes(
	branch: readonly SessionEntry[],
	maxBytes: number,
	request: MemoryNotesQuery = {},
): MemoryNotesListResult {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) {
		throw new Error("notes result maxBytes must be an integer of at least 512");
	}
	if (request.query !== undefined && !request.query.trim())
		throw new MemoryNoteValidationError("search query must not be empty");
	const query = request.query?.toLowerCase();
	const notes = recentNotes(branch).filter(
		(note) =>
			(!request.category || note.category === request.category) &&
			(!request.workflowId || note.workflowId === request.workflowId) &&
			(!request.taskId || note.taskId === request.taskId) &&
			(query === undefined ||
				[note.title, note.content, ...note.keywords].some((text) => text.toLowerCase().includes(query))),
	);
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				request.query,
				request.category,
				request.workflowId,
				request.taskId,
				notes.map((note) => note.entryId),
			]),
		)
		.digest("hex");
	const offset = cursorOffset(request.cursor, fingerprint, notes.length);
	const selected: MemoryNoteIndex[] = [];
	const result = (): MemoryNotesListResult => ({
		schemaVersion: 1,
		action: query === undefined ? "list" : "search",
		notes: [...selected],
		truncated: offset + selected.length < notes.length,
		...(offset + selected.length < notes.length ? { nextCursor: `${fingerprint}:${offset + selected.length}` } : {}),
	});
	for (const note of notes.slice(offset)) {
		const index = memoryNoteIndex(note);
		const matchAt = query === undefined ? -1 : note.content.toLowerCase().indexOf(query);
		selected.push(
			query === undefined
				? index
				: { ...index, snippet: truncateUtf8(note.content.slice(Math.max(0, matchAt)), 160).content },
		);
		if (serializedBytes(result()) <= maxBytes) continue;
		selected.pop();
		if (selected.length === 0)
			throw new MemoryNoteValidationError("result budget cannot fit one note index; increase maxBytes");
		break;
	}
	return result();
}

export function readMemoryNote(
	branch: readonly SessionEntry[],
	request: MemoryNoteReadRequest,
	maxBytes: number,
): MemoryNoteReadResult {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 512)
		throw new MemoryNoteValidationError("notes result maxBytes must be an integer of at least 512");
	const note = getMemoryNotes(branch).find((item) => item.noteId === request.noteId);
	if (!note) throw new MemoryNoteValidationError(`active note ${request.noteId} does not exist on the current branch`);
	const characters = Array.from(note.content);
	const fingerprint = createHash("sha256")
		.update(JSON.stringify([note.noteId, note.entryId]))
		.digest("hex");
	const start = cursorOffset(request.cursor, fingerprint, characters.length);
	const result = (end: number): MemoryNoteReadResult => ({
		schemaVersion: 1,
		action: "read",
		note: { ...note, content: characters.slice(start, end).join("") },
		truncated: end < characters.length,
		...(end < characters.length ? { nextCursor: `${fingerprint}:${end}` } : {}),
	});
	const full = result(characters.length);
	if (serializedBytes(full) <= maxBytes) return full;
	let low = start;
	let high = characters.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (serializedBytes(result(mid)) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	if (low === start)
		throw new MemoryNoteValidationError("result budget cannot fit note metadata and content; increase maxBytes");
	return result(low);
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

export function buildMemoryNotesHint(branch: readonly SessionEntry[], maxBytes: number): MemoryNotesHint {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error("notes hint maxBytes must be a positive integer");
	}
	const notes = recentNotes(branch);
	const header = "Recent Notes index (newest update first; non-authoritative; Workflow Snapshot wins):";
	const footer =
		"Use visible facts first; read notes by note_id for gaps, search/list omitted notes. Stop when facts suffice without conflict. Use History for gaps, conflicts or original evidence; prefer known source IDs.";
	const marker = "[notes truncated]";
	if (Buffer.byteLength(`${header}\n${marker}\n${footer}`, "utf8") > maxBytes) {
		const minimal = 'Notes: use notes action="list" or "search", then "read".';
		return {
			content: Buffer.byteLength(minimal, "utf8") <= maxBytes ? minimal : "",
			noteEntryIds: [],
			truncated: notes.length > 0,
		};
	}
	let content = header;
	const noteEntryIds: string[] = [];
	for (const note of notes) {
		const line = `- ${note.noteId} [${note.category}] ${JSON.stringify(note.title)}`;
		const candidate = `${content}\n${line}`;
		if (Buffer.byteLength(`${candidate}\n${marker}\n${footer}`, "utf8") > maxBytes) break;
		content = candidate;
		noteEntryIds.push(note.entryId);
	}
	const truncated = noteEntryIds.length < notes.length;
	return { content: `${content}${truncated ? `\n${marker}` : ""}\n${footer}`, noteEntryIds, truncated };
}
