export const CONTEXT_MANAGEMENT_MODES = ["summary", "windowed", "hybrid"] as const;

export type ContextManagementMode = (typeof CONTEXT_MANAGEMENT_MODES)[number];

export const CONTEXT_WINDOW_REASONS = ["manual", "model", "threshold", "overflow"] as const;

export type ContextWindowReason = (typeof CONTEXT_WINDOW_REASONS)[number];

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
