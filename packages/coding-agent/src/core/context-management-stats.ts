import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "./compaction/index.ts";
import type { ContextManagementMode, ContextWindowLineage, ContextWindowReason } from "./context-management.ts";
import type { HistoryQueryResult } from "./history.ts";
import { getHistoryResultCount } from "./history.ts";
import { assertValidMemoryNoteEntryData, getMemoryNotes, MEMORY_NOTE_CUSTOM_TYPE } from "./notes.ts";
import type { SessionEntry } from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

export interface ContextManagementTokenTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

export interface ContextManagementStats {
	readonly mode: ContextManagementMode;
	readonly currentWindow: {
		readonly windowId: string | null;
		readonly firstWindowId: string | null;
		readonly previousWindowId: string | null;
		readonly windowIndex: number;
		readonly entryCount: number;
		readonly activeMessageCount: number;
		readonly estimatedTokens: number;
	};
	readonly hardCuts: {
		readonly count: number;
		readonly seedBytes: number;
		readonly estimatedSeedTokens: number;
		readonly modelCallTokens: 0;
	};
	readonly history: {
		readonly queryCount: number;
		readonly resultBytes: number;
		readonly estimatedResultTokens: number;
	};
	readonly notes: {
		readonly operationCount: number;
		readonly activeCount: number;
		readonly toolResultCount: number;
		readonly resultBytes: number;
		readonly estimatedResultTokens: number;
	};
	readonly summaries: {
		readonly count: number;
		readonly tokens: ContextManagementTokenTotals;
		readonly cost: number;
	};
}

export interface ContextWindowTraceEntry {
	readonly entryId: string;
	readonly timestamp: string;
	readonly reason: ContextWindowReason;
	readonly windowId: string;
	readonly firstWindowId: string;
	readonly previousWindowId: string;
	readonly windowIndex: number;
	readonly tokensBefore: number;
	readonly seedBytes: number;
	readonly noteCount: number;
	readonly snapshotEntryId?: string;
	readonly workflowId?: string;
}

export interface HistoryQueryTraceEntry {
	readonly entryId: string;
	readonly timestamp: string;
	readonly toolCallId: string;
	readonly action: "list" | "search" | "read" | "unknown";
	readonly request: Readonly<Record<string, unknown>> | null;
	readonly resultCount: number;
	readonly resultBytes: number;
	readonly truncated: boolean;
}

export interface NoteOperationTraceEntry {
	readonly entryId: string;
	readonly timestamp: string;
	readonly noteId: string;
	readonly operation: "upsert" | "archive";
	readonly category: string;
	readonly workflowId?: string;
	readonly taskId?: string;
}

export interface ContextManagementTrace {
	readonly schemaVersion: 1;
	readonly stats: ContextManagementStats;
	readonly lineage: ContextWindowLineage | null;
	readonly windows: readonly ContextWindowTraceEntry[];
	readonly historyQueries: readonly HistoryQueryTraceEntry[];
	readonly noteOperations: readonly NoteOperationTraceEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function estimatedTokensFromBytes(bytes: number): number {
	return Math.ceil(bytes / 4);
}

function messageText(entry: SessionEntry): string {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return "";
	return contentText(entry.message.content, "");
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function historyAction(value: unknown): HistoryQueryTraceEntry["action"] {
	return value === "list" || value === "search" || value === "read" ? value : "unknown";
}

function historyResultCount(value: Record<string, unknown> | null): number {
	if (!value || historyAction(value.action) === "unknown") return 0;
	const result = value as unknown as HistoryQueryResult;
	try {
		return getHistoryResultCount(result);
	} catch {
		return 0;
	}
}

function historyRequests(branch: readonly SessionEntry[]): Map<string, Readonly<Record<string, unknown>>> {
	const requests = new Map<string, Readonly<Record<string, unknown>>>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
			continue;
		}
		for (const part of entry.message.content) {
			if (part.type === "toolCall" && part.name === "history" && isRecord(part.arguments)) {
				requests.set(part.id, { ...part.arguments });
			}
		}
	}
	return requests;
}

export function buildContextManagementTrace(
	branch: readonly SessionEntry[],
	activeMessages: readonly AgentMessage[],
	mode: ContextManagementMode,
	lineage: ContextWindowLineage | null,
): ContextManagementTrace {
	const windows: ContextWindowTraceEntry[] = [];
	let seedBytes = 0;
	for (const entry of branch) {
		if (entry.type !== "context_window") continue;
		const entrySeedBytes = Buffer.byteLength(entry.contextSeed.content, "utf8");
		seedBytes += entrySeedBytes;
		windows.push({
			entryId: entry.id,
			timestamp: entry.timestamp,
			reason: entry.reason,
			windowId: entry.windowId,
			firstWindowId: entry.firstWindowId,
			previousWindowId: entry.previousWindowId,
			windowIndex: entry.windowIndex,
			tokensBefore: entry.tokensBefore,
			seedBytes: entrySeedBytes,
			noteCount: entry.contextSeed.noteEntryIds.length,
			...(entry.snapshotEntryId ? { snapshotEntryId: entry.snapshotEntryId } : {}),
			...(entry.workflowId ? { workflowId: entry.workflowId } : {}),
		});
	}

	const requests = historyRequests(branch);
	const historyQueries: HistoryQueryTraceEntry[] = [];
	let historyResultBytes = 0;
	let notesToolResultCount = 0;
	let notesResultBytes = 0;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const output = messageText(entry);
		const outputBytes = Buffer.byteLength(output, "utf8");
		if (entry.message.toolName === "history") {
			const result = parseJsonRecord(output);
			historyResultBytes += outputBytes;
			historyQueries.push({
				entryId: entry.id,
				timestamp: entry.timestamp,
				toolCallId: entry.message.toolCallId,
				action: historyAction(result?.action),
				request: requests.get(entry.message.toolCallId) ?? null,
				resultCount: historyResultCount(result),
				resultBytes: outputBytes,
				truncated: result?.truncated === true,
			});
		} else if (entry.message.toolName === "notes") {
			notesToolResultCount++;
			notesResultBytes += outputBytes;
		}
	}

	const noteOperations: NoteOperationTraceEntry[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_NOTE_CUSTOM_TYPE) continue;
		assertValidMemoryNoteEntryData(entry.data, entry.id);
		noteOperations.push({
			entryId: entry.id,
			timestamp: entry.timestamp,
			noteId: entry.data.noteId,
			operation: entry.data.operation,
			category: entry.data.category,
			...(entry.data.workflowId ? { workflowId: entry.data.workflowId } : {}),
			...(entry.data.taskId ? { taskId: entry.data.taskId } : {}),
		});
	}

	const summaryUsage = createUsageTotals();
	let summaryCount = 0;
	for (const entry of branch) {
		if (entry.type !== "compaction") continue;
		summaryCount++;
		if (entry.usage) addUsageToTotals(summaryUsage, entry.usage);
	}
	const summaryTokenTotal =
		summaryUsage.input + summaryUsage.output + summaryUsage.cacheRead + summaryUsage.cacheWrite;

	let currentWindowStart = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index].type === "context_window") {
			currentWindowStart = index;
			break;
		}
	}
	const currentWindowEntries = branch.slice(currentWindowStart + 1);
	const estimatedActiveTokens = Math.ceil(estimateContextTokens([...activeMessages]).tokens);
	const stats: ContextManagementStats = {
		mode,
		currentWindow: {
			windowId: lineage?.windowId ?? null,
			firstWindowId: lineage?.firstWindowId ?? null,
			previousWindowId: lineage?.previousWindowId ?? null,
			windowIndex: lineage?.windowIndex ?? 0,
			entryCount: currentWindowEntries.length,
			activeMessageCount: activeMessages.length,
			estimatedTokens: Number.isFinite(estimatedActiveTokens) ? Math.max(0, estimatedActiveTokens) : 0,
		},
		hardCuts: {
			count: windows.length,
			seedBytes,
			estimatedSeedTokens: estimatedTokensFromBytes(seedBytes),
			modelCallTokens: 0,
		},
		history: {
			queryCount: historyQueries.length,
			resultBytes: historyResultBytes,
			estimatedResultTokens: estimatedTokensFromBytes(historyResultBytes),
		},
		notes: {
			operationCount: noteOperations.length,
			activeCount: getMemoryNotes(branch).length,
			toolResultCount: notesToolResultCount,
			resultBytes: notesResultBytes,
			estimatedResultTokens: estimatedTokensFromBytes(notesResultBytes),
		},
		summaries: {
			count: summaryCount,
			tokens: {
				input: summaryUsage.input,
				output: summaryUsage.output,
				cacheRead: summaryUsage.cacheRead,
				cacheWrite: summaryUsage.cacheWrite,
				total: summaryTokenTotal,
			},
			cost: summaryUsage.cost,
		},
	};

	return {
		schemaVersion: 1,
		stats,
		lineage,
		windows,
		historyQueries,
		noteOperations,
	};
}
