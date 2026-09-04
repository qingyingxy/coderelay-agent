import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { HISTORY_ROLES, type HistoryQueryRequest, type HistoryQueryResult, type HistoryRole } from "../history.ts";

const historySchema = Type.Object(
	{
		action: Type.Union([Type.Literal("list"), Type.Literal("search"), Type.Literal("read")]),
		query: Type.Optional(
			Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
				description: "Text to find for search; use null for list/read",
			}),
		),
		role: Type.Optional(
			Type.Union([...HISTORY_ROLES.map((role) => Type.Literal(role)), Type.Null()], {
				description: "Role filter for search; use null for no filter or other actions",
			}),
		),
		tool: Type.Optional(
			Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
				description: "Exact tool name filter for search; use null for no filter or other actions",
			}),
		),
		window_id: Type.Optional(
			Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
				description: "Intentional window filter or read target; otherwise use null",
			}),
		),
		entry_ids: Type.Optional(
			Type.Union(
				[Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 50 }), Type.Null()],
				{ description: "Entry IDs for read; otherwise use null" },
			),
		),
		cursor: Type.Optional(
			Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
				description: "Opaque continuation cursor from a prior call; use null on the first call",
			}),
		),
		limit: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: 50 }), Type.Null()], {
				description: "Maximum result count; use null for the default",
			}),
		),
	},
	{ additionalProperties: false },
);

export interface HistoryToolDetails {
	readonly result: HistoryQueryResult;
	readonly resultBytes: number;
}

function toRequest(params: {
	readonly action: "list" | "search" | "read";
	readonly query?: string | null;
	readonly role?: HistoryRole | null;
	readonly tool?: string | null;
	readonly window_id?: string | null;
	readonly entry_ids?: readonly string[] | null;
	readonly cursor?: string | null;
	readonly limit?: number | null;
}): HistoryQueryRequest {
	if (params.action === "list") {
		return { action: "list", cursor: params.cursor ?? undefined, limit: params.limit ?? undefined };
	}
	if (params.action === "search") {
		if (!params.query) throw new Error("history search requires query");
		return {
			action: "search",
			query: params.query,
			role: params.role ?? undefined,
			tool: params.tool ?? undefined,
			windowId: params.window_id ?? undefined,
			cursor: params.cursor ?? undefined,
			limit: params.limit ?? undefined,
		};
	}
	return {
		action: "read",
		entryIds: params.entry_ids ?? undefined,
		windowId: params.window_id ?? undefined,
		cursor: params.cursor ?? undefined,
		limit: params.limit ?? undefined,
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
