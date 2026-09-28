import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { HISTORY_ROLES, type HistoryQueryRequest, type HistoryQueryResult, type HistoryRole } from "../history.ts";
import {
	MEMORY_REVISION_GUIDELINE,
	MEMORY_TARGETED_SEARCH_GUIDELINE,
	WORKFLOW_PROJECTION_RETRIEVAL_GUIDELINE,
	WORKFLOW_RECEIPT_RETRIEVAL_GUIDELINE,
} from "../memory-retrieval-policy.ts";
import { getTextOutput } from "./render-utils.ts";

const roleLabels: Record<HistoryRole, string> = {
	user: "用户消息",
	assistant: "助手消息",
	toolResult: "工具结果",
	custom: "自定义消息",
	bashExecution: "命令执行",
	branchSummary: "分支摘要",
	compaction: "上下文摘要",
};

function displayText(value: string): string {
	return sanitizeBinaryOutput(stripAnsi(value)).replace(/\r/g, "");
}

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
			"Treat the current workspace as authoritative for current code, symbols, methods, files, configuration and repository state. Inspect information that still exists there with workspace read/search tools; never query History for it.",
			WORKFLOW_PROJECTION_RETRIEVAL_GUIDELINE,
			"Use History only for missing user wording, historical decisions, unavailable prior tool results, conflicts or original evidence that cannot be reconstructed from the current workspace. When a visible Active Note body already contains the complete exact rule and no conflict or requested evidence remains, do not query History to reconfirm it or merely obtain provenance/source Entry IDs. Read known source Entry IDs directly only when original evidence is actually required; otherwise search, then read relevant returned IDs. Stop when the requested information is sufficiently supported.",
			WORKFLOW_RECEIPT_RETRIEVAL_GUIDELINE,
			MEMORY_REVISION_GUIDELINE,
			MEMORY_TARGETED_SEARCH_GUIDELINE,
		],
		parameters: historySchema,
		renderCall(args, theme) {
			const action = { list: "查看上下文窗口", search: "搜索历史", read: "读取历史" }[args.action] ?? "历史记录";
			const query = args.query ? ` · ${displayText(args.query).slice(0, 120)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold(`History · ${action}`)) + query, 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (context.isError) {
				return new Text(theme.fg("error", `历史查询失败\n${getTextOutput(result, false)}`), 0, 0);
			}
			if (options.isPartial) return new Text(theme.fg("muted", "正在查询历史记录…"), 0, 0);
			const data = result.details?.result;
			if (!data) return new Text(getTextOutput(result, false), 0, 0);
			const lines: string[] = [];
			if (data.action === "list") {
				lines.push(`历史记录 · 本页 ${data.windows.length} 个上下文窗口`);
				for (const window of data.windows.slice(0, options.expanded ? undefined : 3)) {
					lines.push(
						`窗口 ${window.windowIndex}${window.current ? "（当前）" : ""} · ${window.readableEntryCount} 条可读记录`,
					);
				}
				if (!options.expanded && data.windows.length > 3)
					lines.push(`另有 ${data.windows.length - 3} 个窗口，展开查看`);
			} else {
				const entries = data.action === "search" ? data.matches : data.entries;
				lines.push(
					entries.length
						? `历史记录 · 本页 ${entries.length} 条${data.action === "search" ? "相关结果" : "记录"}`
						: "历史记录 · 未找到记录",
				);
				for (const entry of entries.slice(0, options.expanded ? undefined : 3)) {
					const source = entry.toolNames?.length
						? `${entry.toolNames.join("、")}（${roleLabels[entry.role]}）`
						: roleLabels[entry.role];
					lines.push(`来源：${displayText(source)}`);
					const content = displayText("snippet" in entry ? entry.snippet : entry.content);
					const preview = content.split("\n").slice(0, 3).join("\n").slice(0, 300);
					lines.push(options.expanded ? content : preview);
					if (!options.expanded && preview.length < content.length) lines.push("… 内容预览已折叠");
					if ("contentTruncated" in entry && entry.contentTruncated) lines.push("本条仅返回部分内容");
				}
				if (!options.expanded && entries.length > 3) lines.push(`另有 ${entries.length - 3} 条记录，展开查看`);
				if (data.action === "read" && data.unavailableEntryIds?.length)
					lines.push(`${data.unavailableEntryIds.length} 条请求记录不可用`);
			}
			if (data.truncated) lines.push("结果未完整返回");
			if (data.nextCursor) lines.push("还有后续内容，可继续查询");
			if (options.expanded) {
				lines.push("", "原始返回详情（记录编号、窗口编号及时间）", JSON.stringify(data, null, 2));
			} else {
				lines.push(keyHint("app.tools.expand", "展开原始详情"));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
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
