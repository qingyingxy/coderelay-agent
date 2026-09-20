import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { HistoryQueryResult } from "../src/core/history.ts";
import { createHistoryToolDefinition } from "../src/core/tools/history.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const search: HistoryQueryResult = {
	schemaVersion: 1,
	action: "search",
	truncated: false,
	matches: [
		{
			entryId: "entry-secret-id",
			windowId: "window-secret-id",
			timestamp: "2026-09-16T00:00:00Z",
			role: "toolResult",
			toolNames: ["verify_config"],
			snippet: "测试结果：2/3 通过\n失败：文件不存在时使用默认端口 3000",
		},
	],
};

function render(
	data: HistoryQueryResult | undefined,
	options: { expanded?: boolean; isError?: boolean; isPartial?: boolean; width?: number } = {},
) {
	const tool = createHistoryToolDefinition(() => search);
	const expanded = options.expanded ?? false;
	const isPartial = options.isPartial ?? false;
	const component = tool.renderResult!(
		{
			content: [{ type: "text", text: "查询失败原因" }],
			details: data ? { result: data, resultBytes: 0 } : undefined!,
		},
		{ expanded, isPartial },
		theme,
		{
			args: { action: "search", query: "失败" },
			toolCallId: "test",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError: options.isError ?? false,
		},
	);
	return component.render(options.width ?? 100);
}

describe("History tool rendering", () => {
	beforeAll(() => initTheme(undefined, false));
	it("shows actual source and evidence without raw JSON or record IDs by default", () => {
		const text = render(search).map(stripAnsi).join("\n");
		expect(text).toContain("本页 1 条相关结果");
		expect(text).toContain("verify_config（工具结果）");
		expect(text).toContain("失败：文件不存在时使用默认端口 3000");
		expect(text).not.toMatch(/schemaVersion|entry-secret-id|window-secret-id/);
		const expanded = render(search, { expanded: true }).map(stripAnsi).join("\n");
		expect(expanded).toContain("entry-secret-id");
		expect(expanded).toContain("window-secret-id");
		expect(expanded).toContain("2026-09-16T00:00:00Z");
	});
	it("distinguishes no matches, partial responses, and failed queries", () => {
		expect(render({ ...search, matches: [] }).join("\n")).toContain("未找到记录");
		expect(render(undefined, { isPartial: true }).join("\n")).toContain("正在查询");
		const failure = render(search, { isError: true }).join("\n");
		expect(failure).toContain("历史查询失败");
		expect(failure).toContain("查询失败原因");
		expect(failure).not.toContain("相关结果");
		expect(render(undefined).join("\n")).toContain("查询失败原因");
	});
	it("lists windows and indicates missing records, truncated content and continuation", () => {
		expect(
			render({
				schemaVersion: 1,
				action: "list",
				truncated: false,
				windows: [
					{ windowId: "w", windowIndex: 2, current: true, startedAt: "now", entryCount: 3, readableEntryCount: 2 },
				],
			}).join("\n"),
		).toContain("窗口 2（当前） · 2 条可读记录");
		const text = render({
			schemaVersion: 1,
			action: "read",
			truncated: true,
			nextCursor: "cursor",
			unavailableEntryIds: ["gone"],
			entries: [
				{
					entryId: "e",
					windowId: "w",
					timestamp: "now",
					role: "user",
					content: "部分内容",
					contentOffsetBytes: 0,
					contentBytes: 12,
					totalContentBytes: 100,
					contentTruncated: true,
				},
			],
		}).join("\n");
		for (const expected of ["部分内容", "本条仅返回部分内容", "1 条请求记录不可用", "结果未完整返回", "还有后续内容"])
			expect(text).toContain(expected);
	});
	it("bounds collapsed previews, sanitizes terminal escapes and wraps narrow terminals", () => {
		const data = {
			...search,
			matches: Array.from({ length: 4 }, (_, i) => ({
				...search.matches[0],
				snippet: `\u001b[31m记录${i}\u001b[0m\n${"中文内容".repeat(100)}\n第三行\n末尾证据`,
			})),
		};
		const lines = render(data, { width: 24 });
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		const text = lines.map(stripAnsi).join("\n");
		expect(text).not.toContain("末尾证据");
		expect(text).not.toContain("记录3");
		expect(text).toContain("另有 1 条记录");
		expect(text).not.toContain("\u001b");
		expect(render(data, { expanded: true }).join("\n")).toContain("末尾证据");
	});
});
