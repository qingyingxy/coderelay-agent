import { describe, expect, it } from "vitest";
import {
	CONTEXT_MANAGEMENT_EVENT_TYPES,
	CONTEXT_MANAGEMENT_MODES,
	CONTEXT_WINDOW_REASONS,
} from "../src/core/context-management.ts";
import {
	type ContextManagementSettings,
	DEFAULT_CONTEXT_MANAGEMENT_RESERVE_TOKENS,
	DEFAULT_HISTORY_RESULT_MAX_BYTES,
	DEFAULT_NOTES_HINT_MAX_BYTES,
	InMemorySettingsStorage,
	SettingsManager,
} from "../src/core/settings-manager.ts";

describe("context management baseline", () => {
	it("keeps summary compaction as the default", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getContextManagementSettings()).toEqual({
			mode: "summary",
			reserveTokens: DEFAULT_CONTEXT_MANAGEMENT_RESERVE_TOKENS,
			notesHintMaxBytes: DEFAULT_NOTES_HINT_MAX_BYTES,
			historyResultMaxBytes: DEFAULT_HISTORY_RESULT_MAX_BYTES,
		});
		expect(manager.getCompactionEnabled()).toBe(true);
	});

	it("deep merges global, project, and runtime settings", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				contextManagement: {
					mode: "windowed",
					reserveTokens: 12_000,
					notesHintMaxBytes: 3_000,
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				contextManagement: {
					mode: "hybrid",
					historyResultMaxBytes: 8_000,
				},
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		manager.applyOverrides({ contextManagement: { reserveTokens: 10_000 } });

		expect(manager.getContextManagementSettings()).toEqual({
			mode: "hybrid",
			reserveTokens: 10_000,
			notesHintMaxBytes: 3_000,
			historyResultMaxBytes: 8_000,
		});
	});

	it.each([
		["mode", { mode: "invalid" }],
		["reserveTokens", { reserveTokens: 0 }],
		["notesHintMaxBytes", { notesHintMaxBytes: -1 }],
		["historyResultMaxBytes", { historyResultMaxBytes: 1.5 }],
	] as const)("rejects invalid %s values", (_name, contextManagement) => {
		const manager = SettingsManager.inMemory({
			contextManagement: contextManagement as unknown as ContextManagementSettings,
		});

		expect(() => manager.getContextManagementSettings()).toThrow("Invalid contextManagement.");
	});

	it("fixes the public modes, reasons, and event names", () => {
		expect(CONTEXT_MANAGEMENT_MODES).toEqual(["summary", "windowed", "hybrid"]);
		expect(CONTEXT_WINDOW_REASONS).toEqual(["manual", "model", "threshold", "overflow"]);
		expect(CONTEXT_MANAGEMENT_EVENT_TYPES).toEqual([
			"context_window_warning",
			"context_window_requested",
			"context_window_start",
			"context_window_end",
			"context_window_failed",
			"history_query",
			"notes_changed",
		]);
	});
});
