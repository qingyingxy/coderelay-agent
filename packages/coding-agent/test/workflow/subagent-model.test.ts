import { afterEach, describe, expect, it } from "vitest";
import { resolveSubagentModelName } from "../../src/core/subagents/subagent-model.ts";

const originalProvider = process.env.PI_PROVIDER;
const originalModel = process.env.PI_MODEL;

afterEach(() => {
	if (originalProvider === undefined) delete process.env.PI_PROVIDER;
	else process.env.PI_PROVIDER = originalProvider;
	if (originalModel === undefined) delete process.env.PI_MODEL;
	else process.env.PI_MODEL = originalModel;
});

describe("resolveSubagentModelName", () => {
	it("inherits the active process model before persisted Settings", () => {
		process.env.PI_PROVIDER = "deepseek";
		process.env.PI_MODEL = "deepseek-v4-flash";

		expect(resolveSubagentModelName(process.cwd(), undefined)).toBe("deepseek/deepseek-v4-flash");
	});

	it("keeps an explicit profile model authoritative", () => {
		process.env.PI_PROVIDER = "deepseek";
		process.env.PI_MODEL = "deepseek-v4-flash";

		expect(resolveSubagentModelName(process.cwd(), "opencode-go/qwen3.7-plus")).toBe("opencode-go/qwen3.7-plus");
	});
});
