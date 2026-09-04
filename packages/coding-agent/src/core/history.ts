import { assertValidContextWindowLineage, type ContextWindowReason } from "./context-management.ts";
import type { SessionEntry } from "./session-manager.ts";

export const HISTORY_ROLES = [
	"user",
	"assistant",
	"toolResult",
	"custom",
	"bashExecution",
	"branchSummary",
	"compaction",
] as const;

export type HistoryRole = (typeof HISTORY_ROLES)[number];

export interface HistoryListRequest {
	readonly action: "list";
	readonly cursor?: string;
	readonly limit?: number;
}

export interface HistorySearchRequest {
	readonly action: "search";
	readonly query: string;
	readonly role?: HistoryRole;
	readonly tool?: string;
	readonly windowId?: string;
	readonly cursor?: string;
	readonly limit?: number;
}

export interface HistoryReadRequest {
	readonly action: "read";
	readonly entryIds?: readonly string[];
	readonly windowId?: string;
	readonly cursor?: string;
	readonly limit?: number;
}

export type HistoryQueryRequest = HistoryListRequest | HistorySearchRequest | HistoryReadRequest;

export interface HistoryWindowView {
	readonly windowId: string;
	readonly windowIndex: number;
	readonly current: boolean;
	readonly reason?: ContextWindowReason;
	readonly boundaryEntryId?: string;
	readonly startEntryId?: string;
	readonly endEntryId?: string;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly entryCount: number;
	readonly readableEntryCount: number;
}

export interface HistorySearchMatch {
	readonly entryId: string;
	readonly windowId: string;
	readonly timestamp: string;
	readonly role: HistoryRole;
	readonly toolNames?: readonly string[];
	readonly snippet: string;
}

export interface HistoryReadEntry {
	readonly entryId: string;
	readonly windowId: string;
	readonly timestamp: string;
	readonly role: HistoryRole;
	readonly toolNames?: readonly string[];
	readonly content: string;
	readonly contentOffsetBytes: number;
	readonly contentBytes: number;
	readonly totalContentBytes: number;
	readonly contentTruncated: boolean;
}

interface HistoryResultBase {
	readonly schemaVersion: 1;
	readonly action: HistoryQueryRequest["action"];
	readonly truncated: boolean;
	readonly nextCursor?: string;
}

export interface HistoryListResult extends HistoryResultBase {
	readonly action: "list";
	readonly windows: readonly HistoryWindowView[];
}

export interface HistorySearchResult extends HistoryResultBase {
	readonly action: "search";
	readonly matches: readonly HistorySearchMatch[];
}

export interface HistoryReadResult extends HistoryResultBase {
	readonly action: "read";
	readonly entries: readonly HistoryReadEntry[];
	readonly unavailableEntryIds?: readonly string[];
}

export type HistoryQueryResult = HistoryListResult | HistorySearchResult | HistoryReadResult;

interface IndexedHistoryEntry {
	readonly entry: SessionEntry;
	readonly windowId: string;
}

interface HistoryIndex {
	readonly windows: readonly HistoryWindowView[];
	readonly entries: readonly IndexedHistoryEntry[];
	readonly windowIds: ReadonlySet<string>;
}

interface HistoryCursor {
	readonly schemaVersion: 1;
	readonly action: HistoryQueryRequest["action"];
	readonly index: number;
	readonly contentOffsetBytes?: number;
}

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;
const MAX_SEARCH_SNIPPET_BYTES = 800;
const MIN_HISTORY_RESULT_MAX_BYTES = 2_048;
const IMPLICIT_INITIAL_WINDOW_ID = "implicit-initial";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function isSuppressed(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.excludeFromContext === true || value.sensitive === true || value.excludeFromHistory === true)
	);
}

function stringifyValue(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content === undefined ? "" : stringifyValue(content);
	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) {
			parts.push(stringifyValue(part));
			continue;
		}
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		} else if (part.type === "thinking" && typeof part.thinking === "string") {
			parts.push(`[thinking]\n${part.thinking}`);
		} else if (part.type === "toolCall") {
			const name = typeof part.name === "string" ? part.name : "unknown";
			const id = typeof part.id === "string" ? ` ${part.id}` : "";
			parts.push(`[tool call ${name}${id}]\n${stringifyValue(part.arguments ?? part.args ?? {})}`);
		} else if (part.type === "image") {
			const mimeType = typeof part.mimeType === "string" ? ` ${part.mimeType}` : "";
			parts.push(`[image${mimeType}]`);
		} else {
			parts.push(stringifyValue(part));
		}
	}
	return parts.join("\n");
}

function entryRole(entry: SessionEntry): HistoryRole | undefined {
	if (entry.type === "custom_message") return "custom";
	if (entry.type === "branch_summary") return "branchSummary";
	if (entry.type === "compaction") return "compaction";
	if (entry.type !== "message") return undefined;
	const role = readString(entry.message, "role");
	if (role === "branchSummary") return "branchSummary";
	if (role === "compactionSummary") return "compaction";
	return HISTORY_ROLES.find((candidate) => candidate === role);
}

function entryToolNames(entry: SessionEntry): string[] {
	if (entry.type !== "message") return [];
	const message = entry.message;
	if (message.role === "toolResult") {
		const toolName = readString(message, "toolName");
		return toolName ? [toolName] : [];
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const names: string[] = [];
	for (const part of message.content) {
		if (isRecord(part) && part.type === "toolCall" && typeof part.name === "string") {
			names.push(part.name);
		}
	}
	return [...new Set(names)];
}

function entryText(entry: SessionEntry): string {
	if (entry.type === "custom_message") return renderContent(entry.content);
	if (entry.type === "branch_summary") return entry.summary;
	if (entry.type === "compaction") return entry.summary;
	if (entry.type !== "message") return "";
	const message = entry.message;
	switch (message.role) {
		case "bashExecution":
			return [`Command: ${message.command}`, message.output].filter(Boolean).join("\n");
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return renderContent(message.content);
	}
}

function isReadableHistoryEntry(entry: SessionEntry): boolean {
	const role = entryRole(entry);
	if (!role || isSuppressed(entry)) return false;
	if (entry.type === "custom_message") {
		return !isSuppressed(entry.details) && entry.customType !== "history";
	}
	if (entry.type !== "message") return true;
	if (isSuppressed(entry.message)) return false;
	return !entryToolNames(entry).includes("history");
}

function buildHistoryIndex(branch: readonly SessionEntry[]): HistoryIndex {
	assertValidContextWindowLineage(branch);
	if (branch.length === 0) {
		return { windows: [], entries: [], windowIds: new Set() };
	}

	const firstBoundary = branch.find((entry) => entry.type === "context_window");
	let windowId = firstBoundary?.type === "context_window" ? firstBoundary.firstWindowId : IMPLICIT_INITIAL_WINDOW_ID;
	let windowIndex = 0;
	let reason: ContextWindowReason | undefined;
	let boundaryEntryId: string | undefined;
	let startedAt = branch[0].timestamp;
	let startEntryId: string | undefined;
	let endEntryId: string | undefined;
	let endedAt: string | undefined;
	let entryCount = 0;
	let readableEntryCount = 0;
	const windows: HistoryWindowView[] = [];
	const indexedEntries: IndexedHistoryEntry[] = [];

	const finishWindow = (current: boolean): void => {
		windows.push({
			windowId,
			windowIndex,
			current,
			...(reason ? { reason } : {}),
			...(boundaryEntryId ? { boundaryEntryId } : {}),
			...(startEntryId ? { startEntryId } : {}),
			...(endEntryId ? { endEntryId } : {}),
			startedAt,
			...(endedAt ? { endedAt } : {}),
			entryCount,
			readableEntryCount,
		});
	};

	for (const entry of branch) {
		if (entry.type === "context_window") {
			finishWindow(false);
			windowId = entry.windowId;
			windowIndex = entry.windowIndex;
			reason = entry.reason;
			boundaryEntryId = entry.id;
			startedAt = entry.timestamp;
			startEntryId = undefined;
			endEntryId = undefined;
			endedAt = undefined;
			entryCount = 0;
			readableEntryCount = 0;
			continue;
		}

		startEntryId ??= entry.id;
		endEntryId = entry.id;
		endedAt = entry.timestamp;
		entryCount++;
		indexedEntries.push({ entry, windowId });
		if (isReadableHistoryEntry(entry)) readableEntryCount++;
	}
	finishWindow(true);

	return {
		windows,
		entries: indexedEntries,
		windowIds: new Set(windows.map((window) => window.windowId)),
	};
}

function parseLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_HISTORY_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
		throw new Error(`history limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`);
	}
	return limit;
}

function encodeCursor(cursor: HistoryCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseCursor(value: string | undefined, action: HistoryQueryRequest["action"]): HistoryCursor {
	if (!value) return { schemaVersion: 1, action, index: 0 };
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== 1 ||
			parsed.action !== action ||
			!Number.isSafeInteger(parsed.index) ||
			(parsed.index as number) < 0 ||
			(parsed.contentOffsetBytes !== undefined &&
				(!Number.isSafeInteger(parsed.contentOffsetBytes) || (parsed.contentOffsetBytes as number) < 0))
		) {
			throw new Error("invalid shape");
		}
		return {
			schemaVersion: 1,
			action,
			index: parsed.index as number,
			...(typeof parsed.contentOffsetBytes === "number" ? { contentOffsetBytes: parsed.contentOffsetBytes } : {}),
		};
	} catch {
		throw new Error(`Invalid history ${action} cursor`);
	}
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fitsBudget(value: unknown, maxBytes: number): boolean {
	const bytes = serializedBytes(value);
	const maxEstimatedTokens = Math.max(1, Math.floor(maxBytes / 4));
	return bytes <= maxBytes && Math.ceil(bytes / 4) <= maxEstimatedTokens;
}

function minimalResult(action: HistoryQueryRequest["action"]): HistoryQueryResult {
	if (action === "list") return { schemaVersion: 1, action, windows: [], truncated: true };
	if (action === "search") return { schemaVersion: 1, action, matches: [], truncated: true };
	return { schemaVersion: 1, action, entries: [], truncated: true };
}

function paginateItems<T>(
	action: "list" | "search",
	items: readonly T[],
	cursorValue: string | undefined,
	limitValue: number | undefined,
	maxBytes: number,
): { readonly items: readonly T[]; readonly nextCursor?: string; readonly truncated: boolean } {
	const cursor = parseCursor(cursorValue, action);
	const limit = parseLimit(limitValue);
	if (cursor.index > items.length) throw new Error(`History ${action} cursor is beyond the available results`);

	const selected: T[] = [];
	let nextIndex = cursor.index;
	while (nextIndex < items.length && selected.length < limit) {
		const proposed = [...selected, items[nextIndex]];
		const followingIndex = nextIndex + 1;
		const nextCursor =
			followingIndex < items.length ? encodeCursor({ schemaVersion: 1, action, index: followingIndex }) : undefined;
		const envelope =
			action === "list"
				? { schemaVersion: 1, action, windows: proposed, truncated: nextCursor !== undefined, nextCursor }
				: { schemaVersion: 1, action, matches: proposed, truncated: nextCursor !== undefined, nextCursor };
		if (!fitsBudget(envelope, maxBytes)) break;
		selected.push(items[nextIndex]);
		nextIndex = followingIndex;
	}

	const truncated = nextIndex < items.length;
	return {
		items: selected,
		...(truncated ? { nextCursor: encodeCursor({ schemaVersion: 1, action, index: nextIndex }) } : {}),
		truncated,
	};
}

function sliceUtf8From(value: string, offsetBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (offsetBytes > buffer.length) throw new Error("History read cursor content offset is beyond the entry");
	return buffer.subarray(offsetBytes).toString("utf8");
}

function utf8PrefixByCharacters(value: string, characterCount: number): string {
	return Array.from(value).slice(0, characterCount).join("");
}

function makeReadEntry(indexed: IndexedHistoryEntry, content: string, contentOffsetBytes: number): HistoryReadEntry {
	const role = entryRole(indexed.entry);
	if (!role) throw new Error(`History Entry ${indexed.entry.id} is not readable`);
	const toolNames = entryToolNames(indexed.entry);
	const contentBytes = Buffer.byteLength(content, "utf8");
	const totalContentBytes = Buffer.byteLength(entryText(indexed.entry), "utf8");
	return {
		entryId: indexed.entry.id,
		windowId: indexed.windowId,
		timestamp: indexed.entry.timestamp,
		role,
		...(toolNames.length > 0 ? { toolNames } : {}),
		content,
		contentOffsetBytes,
		contentBytes,
		totalContentBytes,
		contentTruncated: contentOffsetBytes + contentBytes < totalContentBytes,
	};
}

function fitReadEntry(
	baseEntries: readonly HistoryReadEntry[],
	indexed: IndexedHistoryEntry,
	candidateIndex: number,
	hasFollowingCandidates: boolean,
	contentOffsetBytes: number,
	remainingContent: string,
	maxBytes: number,
	unavailableEntryIds: readonly string[],
): HistoryReadEntry | undefined {
	const fullEntry = makeReadEntry(indexed, remainingContent, contentOffsetBytes);
	const fullNextCursor = hasFollowingCandidates
		? encodeCursor({ schemaVersion: 1, action: "read", index: candidateIndex + 1 })
		: undefined;
	const fullEnvelope: HistoryReadResult = {
		schemaVersion: 1,
		action: "read",
		entries: [...baseEntries, fullEntry],
		...(unavailableEntryIds.length > 0 ? { unavailableEntryIds } : {}),
		truncated: fullNextCursor !== undefined,
		...(fullNextCursor ? { nextCursor: fullNextCursor } : {}),
	};
	if (fitsBudget(fullEnvelope, maxBytes)) return fullEntry;

	const characters = Array.from(remainingContent);
	let low = 0;
	let high = characters.length;
	let best: HistoryReadEntry | undefined;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const content = utf8PrefixByCharacters(remainingContent, middle);
		const candidate = makeReadEntry(indexed, content, contentOffsetBytes);
		const nextOffset = contentOffsetBytes + candidate.contentBytes;
		const envelope: HistoryReadResult = {
			schemaVersion: 1,
			action: "read",
			entries: [...baseEntries, candidate],
			...(unavailableEntryIds.length > 0 ? { unavailableEntryIds } : {}),
			truncated: true,
			nextCursor: encodeCursor({
				schemaVersion: 1,
				action: "read",
				index: candidateIndex,
				contentOffsetBytes: nextOffset,
			}),
		};
		if (middle > 0 && fitsBudget(envelope, maxBytes)) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function searchSnippet(content: string, query: string): string {
	const matchIndex = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
	const start = Math.max(0, matchIndex - 240);
	const end = Math.min(content.length, matchIndex + query.length + 360);
	let snippet = `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
	while (Buffer.byteLength(snippet, "utf8") > MAX_SEARCH_SNIPPET_BYTES && snippet.length > 0) {
		snippet = snippet.slice(0, Math.floor(snippet.length * 0.9));
	}
	return snippet;
}

function listHistory(index: HistoryIndex, request: HistoryListRequest, maxBytes: number): HistoryListResult {
	const page = paginateItems("list", index.windows, request.cursor, request.limit, maxBytes);
	const result: HistoryListResult = {
		schemaVersion: 1,
		action: "list",
		windows: page.items,
		truncated: page.truncated,
		...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
	};
	return fitsBudget(result, maxBytes) ? result : (minimalResult("list") as HistoryListResult);
}

function searchHistory(index: HistoryIndex, request: HistorySearchRequest, maxBytes: number): HistorySearchResult {
	const query = request.query.trim();
	if (!query) throw new Error("history search query must not be empty");
	if (request.windowId && !index.windowIds.has(request.windowId)) {
		throw new Error(`History window ${request.windowId} does not exist on the current branch`);
	}
	const toolFilter = request.tool?.toLocaleLowerCase();
	const queryLower = query.toLocaleLowerCase();
	const matches: HistorySearchMatch[] = [];
	for (const indexed of index.entries) {
		if (!isReadableHistoryEntry(indexed.entry)) continue;
		if (request.windowId && indexed.windowId !== request.windowId) continue;
		const role = entryRole(indexed.entry);
		if (!role || (request.role && role !== request.role)) continue;
		const toolNames = entryToolNames(indexed.entry);
		if (toolFilter && !toolNames.some((name) => name.toLocaleLowerCase() === toolFilter)) continue;
		const content = entryText(indexed.entry);
		if (!content.toLocaleLowerCase().includes(queryLower)) continue;
		matches.push({
			entryId: indexed.entry.id,
			windowId: indexed.windowId,
			timestamp: indexed.entry.timestamp,
			role,
			...(toolNames.length > 0 ? { toolNames } : {}),
			snippet: searchSnippet(content, query),
		});
	}

	const page = paginateItems("search", matches, request.cursor, request.limit, maxBytes);
	const result: HistorySearchResult = {
		schemaVersion: 1,
		action: "search",
		matches: page.items,
		truncated: page.truncated,
		...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
	};
	return fitsBudget(result, maxBytes) ? result : (minimalResult("search") as HistorySearchResult);
}

function readHistory(index: HistoryIndex, request: HistoryReadRequest, maxBytes: number): HistoryReadResult {
	const hasEntryIds = request.entryIds !== undefined;
	const hasWindowId = request.windowId !== undefined;
	if (hasEntryIds === hasWindowId) {
		throw new Error("history read requires exactly one of entry_ids or window_id");
	}
	if (request.windowId && !index.windowIds.has(request.windowId)) {
		throw new Error(`History window ${request.windowId} does not exist on the current branch`);
	}

	const branchById = new Map(index.entries.map((indexed) => [indexed.entry.id, indexed]));
	const unavailableEntryIds: string[] = [];
	let candidates: IndexedHistoryEntry[];
	if (request.entryIds) {
		if (request.entryIds.length === 0 || request.entryIds.length > MAX_HISTORY_LIMIT) {
			throw new Error(`history read entry_ids must contain between 1 and ${MAX_HISTORY_LIMIT} IDs`);
		}
		if (new Set(request.entryIds).size !== request.entryIds.length) {
			throw new Error("history read entry_ids must not contain duplicates");
		}
		candidates = [];
		for (const entryId of request.entryIds) {
			const indexed = branchById.get(entryId);
			if (!indexed || !isReadableHistoryEntry(indexed.entry)) {
				unavailableEntryIds.push(entryId);
			} else {
				candidates.push(indexed);
			}
		}
	} else {
		candidates = index.entries.filter(
			(indexed) => indexed.windowId === request.windowId && isReadableHistoryEntry(indexed.entry),
		);
	}

	const cursor = parseCursor(request.cursor, "read");
	const limit = parseLimit(request.limit);
	if (cursor.index > candidates.length || (cursor.index === candidates.length && cursor.contentOffsetBytes)) {
		throw new Error("History read cursor is beyond the available results");
	}

	const entries: HistoryReadEntry[] = [];
	let nextIndex = cursor.index;
	let contentOffsetBytes = cursor.contentOffsetBytes ?? 0;
	while (nextIndex < candidates.length && entries.length < limit) {
		const indexed = candidates[nextIndex];
		const fullContent = entryText(indexed.entry);
		const remainingContent = sliceUtf8From(fullContent, contentOffsetBytes);
		const fitted = fitReadEntry(
			entries,
			indexed,
			nextIndex,
			nextIndex + 1 < candidates.length,
			contentOffsetBytes,
			remainingContent,
			maxBytes,
			unavailableEntryIds,
		);
		if (!fitted) break;
		entries.push(fitted);
		if (fitted.contentTruncated) {
			contentOffsetBytes += fitted.contentBytes;
			break;
		}
		nextIndex++;
		contentOffsetBytes = 0;
	}

	const lastEntry = entries.at(-1);
	const nextCursor = lastEntry?.contentTruncated
		? encodeCursor({ schemaVersion: 1, action: "read", index: nextIndex, contentOffsetBytes })
		: nextIndex < candidates.length
			? encodeCursor({ schemaVersion: 1, action: "read", index: nextIndex })
			: undefined;
	const result: HistoryReadResult = {
		schemaVersion: 1,
		action: "read",
		entries,
		...(unavailableEntryIds.length > 0 ? { unavailableEntryIds } : {}),
		truncated: nextCursor !== undefined,
		...(nextCursor ? { nextCursor } : {}),
	};
	return fitsBudget(result, maxBytes) ? result : (minimalResult("read") as HistoryReadResult);
}

export function querySessionHistory(
	branch: readonly SessionEntry[],
	request: HistoryQueryRequest,
	maxBytes: number,
): HistoryQueryResult {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_HISTORY_RESULT_MAX_BYTES) {
		throw new Error(`history maxBytes must be an integer of at least ${MIN_HISTORY_RESULT_MAX_BYTES}`);
	}
	const index = buildHistoryIndex(branch);
	switch (request.action) {
		case "list":
			return listHistory(index, request, maxBytes);
		case "search":
			return searchHistory(index, request, maxBytes);
		case "read":
			return readHistory(index, request, maxBytes);
	}
}

export function getHistoryResultCount(result: HistoryQueryResult): number {
	switch (result.action) {
		case "list":
			return result.windows.length;
		case "search":
			return result.matches.length;
		case "read":
			return result.entries.length;
	}
}
