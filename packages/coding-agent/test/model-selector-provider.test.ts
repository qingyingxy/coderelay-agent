import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
	} as Model<Api>;
}

describe("ModelSelectorComponent provider scope", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("only shows models from the active provider", () => {
		const models = [model("openai", "gpt-active"), model("anthropic", "claude-other")];
		const modelRuntime = {
			getAvailableSnapshot: () => models,
			getModel: (providerId: string, modelId: string) =>
				models.find((candidate) => candidate.provider === providerId && candidate.id === modelId),
			refresh: async () => ({ aborted: false, errors: new Map() }),
			getError: () => undefined,
		} as unknown as ModelRuntime;
		const settingsManager = {
			setDefaultModelAndProvider: () => {},
		} as unknown as SettingsManager;
		const tui = {
			requestRender: () => {},
		} as unknown as TUI;

		const selector = new ModelSelectorComponent(
			tui,
			models[0],
			settingsManager,
			modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			"openai",
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain('active provider "openai"');
		expect(output).toContain("gpt-active [openai]");
		expect(output).not.toContain("claude-other");
	});
});
