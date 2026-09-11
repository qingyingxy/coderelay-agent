import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

describe("context mode CLI argument", () => {
	it.each(["summary", "windowed", "hybrid"])("accepts %s without changing workflow mode", (mode) => {
		const parsed = parseArgs(["--context-mode", mode, "--workflow-mode", "direct"]);
		expect(parsed.contextMode).toBe(mode);
		expect(parsed.workflowMode).toBe("direct");
		expect(parsed.diagnostics).toEqual([]);
	});

	it.each([["--context-mode"], ["--context-mode", "invalid"], ["--context-mode", "--offline"]])(
		"rejects missing or invalid modes: %j",
		(...args) => {
			const parsed = parseArgs(args);
			expect(parsed.contextMode).toBeUndefined();
			expect(parsed.diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
			if (args.includes("--offline")) expect(parsed.offline).toBe(true);
		},
	);

	it("does not override settings when omitted", () => {
		expect(parseArgs([]).contextMode).toBeUndefined();
	});
});
