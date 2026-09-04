import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { HISTORY_ROLES, type HistoryQueryRequest, type HistoryQueryResult, type HistoryRole } from "../history.ts";

const historySchema = Type.Object(
	{
		action: Type.Union([Type.Literal("list"), Type.Literal("search"), Type.Literal("read")]),
		query: Type.Optional(Type.String({ minLength: 1, description: "Text to find for search" })),
		role: Type.Optional(Type.Union(HISTORY_ROLES.map((role) => Type.Literal(role)))),
		tool: Type.Optional(Type.String({ minLength: 1, description: "Exact tool name filter for search" })),
		window_id: Type.Optional(Type.String({ minLength: 1, description: "Window ID from history list" })),
		entry_ids: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 50 }),
		),
		cursor: Type.Optional(Type.String({ minLength: 1, description: "Opaque cursor returned by a previous call" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	},
	{ additionalProperties: false },
);

export interface HistoryToolDetails {
	readonly result: HistoryQueryResult;
	readonly resultBytes: number;
}

function toRequest(params: {
	readonly action: "list" | "search" | "read";
	readonly query?: string;
	readonly role?: HistoryRole;
	readonly tool?: string;
	readonly window_id?: string;
	readonly entry_ids?: readonly string[];
	readonly cursor?: string;
	readonly limit?: number;
}): HistoryQueryRequest {
	if (params.action === "list") {
		return { action: "list", cursor: params.cursor, limit: params.limit };
	}
	if (params.action === "search") {
		if (!params.query) throw new Error("history search requires query");
		return {
			action: "search",
			query: params.query,
			role: params.role,
			tool: params.tool,
			windowId: params.window_id,
			cursor: params.cursor,
			limit: params.limit,
		};
	}
	return {
		action: "read",
		entryIds: params.entry_ids,
		windowId: params.window_id,
		cursor: params.cursor,
		limit: params.limit,
	};
}

export function createHistoryToolDefinition(
	query: (request: HistoryQueryRequest) => HistoryQueryResult,
): ToolDefinition<typeof historySchema, HistoryToolDetails> {
	return defineTool({
		name: "history",
		label: "History",
		description:
			"List context windows, search prior session text, or read bounded original entries from the current session branch. Use returned cursors to continue truncated results.",
		promptSnippet: "Retrieve exact prior messages and tool results from the current session branch",
		promptGuidelines: [
			"Use history when an exact detail from an earlier context window is required; search first, then read the returned Entry IDs.",
		],
		parameters: historySchema,
		execute: async (_toolCallId, params) => {
			const result = query(toRequest(params));
			const output = JSON.stringify(result);
			return {
				content: [{ type: "text", text: output }],
				details: { result, resultBytes: Buffer.byteLength(output, "utf8") },
			};
		},
	});
}
