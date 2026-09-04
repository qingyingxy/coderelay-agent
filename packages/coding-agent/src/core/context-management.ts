import type { ContextWindowEntry } from "./session-manager.ts";

export const CONTEXT_MANAGEMENT_MODES = ["summary", "windowed", "hybrid"] as const;

export type ContextManagementMode = (typeof CONTEXT_MANAGEMENT_MODES)[number];

export const CONTEXT_WINDOW_REASONS = ["manual", "model", "threshold", "overflow"] as const;

export type ContextWindowReason = (typeof CONTEXT_WINDOW_REASONS)[number];

export class ContextWindowValidationError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid context window entry: ${issues.join("; ")}`);
		this.name = "ContextWindowValidationError";
		this.issues = issues;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function validateContextWindowEntry(value: unknown): string[] {
	if (!isRecord(value)) {
		return ["entry must be an object"];
	}

	const issues: string[] = [];
	if (value.type !== "context_window") issues.push("type must be context_window");
	if (!isNonEmptyString(value.id)) issues.push("id must be a non-empty string");
	if (value.parentId !== null && !isNonEmptyString(value.parentId)) {
		issues.push("parentId must be null or a non-empty string");
	}
	if (!isNonEmptyString(value.timestamp)) issues.push("timestamp must be a non-empty string");
	if (value.schemaVersion !== 1) issues.push("schemaVersion must be 1");
	if (!isNonEmptyString(value.windowId)) issues.push("windowId must be a non-empty string");
	if (!isNonEmptyString(value.firstWindowId)) issues.push("firstWindowId must be a non-empty string");
	if (!isNonEmptyString(value.previousWindowId)) issues.push("previousWindowId must be a non-empty string");
	if (!Number.isSafeInteger(value.windowIndex) || (value.windowIndex as number) < 1) {
		issues.push("windowIndex must be a positive safe integer");
	}
	if (!CONTEXT_WINDOW_REASONS.includes(value.reason as ContextWindowReason)) {
		issues.push("reason is not supported");
	}
	if (value.snapshotEntryId !== undefined && !isNonEmptyString(value.snapshotEntryId)) {
		issues.push("snapshotEntryId must be a non-empty string when provided");
	}
	if (value.workflowId !== undefined && !isNonEmptyString(value.workflowId)) {
		issues.push("workflowId must be a non-empty string when provided");
	}
	if (!Number.isSafeInteger(value.tokensBefore) || (value.tokensBefore as number) < 0) {
		issues.push("tokensBefore must be a non-negative safe integer");
	}

	if (!isRecord(value.contextSeed)) {
		issues.push("contextSeed must be an object");
	} else {
		const seed = value.contextSeed;
		if (seed.schemaVersion !== 1) issues.push("contextSeed.schemaVersion must be 1");
		if (!isNonEmptyString(seed.content)) issues.push("contextSeed.content must be a non-empty string");
		if (
			seed.workflowSnapshotSequence !== undefined &&
			(!Number.isSafeInteger(seed.workflowSnapshotSequence) || (seed.workflowSnapshotSequence as number) < 0)
		) {
			issues.push("contextSeed.workflowSnapshotSequence must be a non-negative safe integer when provided");
		}
		if (!Array.isArray(seed.noteEntryIds) || !seed.noteEntryIds.every(isNonEmptyString)) {
			issues.push("contextSeed.noteEntryIds must contain only non-empty strings");
		} else if (new Set(seed.noteEntryIds).size !== seed.noteEntryIds.length) {
			issues.push("contextSeed.noteEntryIds must not contain duplicates");
		}
		if (typeof seed.truncated !== "boolean") issues.push("contextSeed.truncated must be a boolean");
	}

	if (
		isNonEmptyString(value.windowId) &&
		(isNonEmptyString(value.firstWindowId) || isNonEmptyString(value.previousWindowId)) &&
		(value.windowId === value.firstWindowId || value.windowId === value.previousWindowId)
	) {
		issues.push("windowId must differ from firstWindowId and previousWindowId");
	}
	if (
		value.windowIndex === 1 &&
		isNonEmptyString(value.firstWindowId) &&
		isNonEmptyString(value.previousWindowId) &&
		value.firstWindowId !== value.previousWindowId
	) {
		issues.push("the first cut must use firstWindowId as previousWindowId");
	}
	if (
		typeof value.windowIndex === "number" &&
		value.windowIndex > 1 &&
		isNonEmptyString(value.firstWindowId) &&
		isNonEmptyString(value.previousWindowId) &&
		value.firstWindowId === value.previousWindowId
	) {
		issues.push("later cuts must not use firstWindowId as previousWindowId");
	}

	return issues;
}

export function assertValidContextWindowEntry(value: unknown): asserts value is ContextWindowEntry {
	const issues = validateContextWindowEntry(value);
	if (issues.length > 0) {
		throw new ContextWindowValidationError(issues);
	}
}

export const CONTEXT_MANAGEMENT_EVENT_TYPES = [
	"context_window_warning",
	"context_window_requested",
	"context_window_start",
	"context_window_end",
	"context_window_failed",
	"history_query",
	"notes_changed",
] as const;

export type ContextManagementEvent =
	| {
			type: "context_window_warning";
			contextTokens: number;
			softLimit: number;
			hardLimit: number;
	  }
	| {
			type: "context_window_requested";
			reason: ContextWindowReason;
			continueAfterCut: boolean;
	  }
	| {
			type: "context_window_start";
			reason: ContextWindowReason;
	  }
	| {
			type: "context_window_end";
			reason: ContextWindowReason;
			windowId: string;
			previousWindowId: string;
			tokensBefore: number;
			estimatedTokensAfter: number;
			snapshotEntryId?: string;
			seedBytes: number;
			noteCount: number;
			continueAfterCut: boolean;
	  }
	| {
			type: "context_window_failed";
			reason: ContextWindowReason;
			error: string;
	  }
	| {
			type: "history_query";
			action: "list" | "search" | "read";
			resultCount: number;
			resultBytes: number;
			truncated: boolean;
	  }
	| {
			type: "notes_changed";
			action: "upsert" | "archive";
			noteId: string;
	  };
