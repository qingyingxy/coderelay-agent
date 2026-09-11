import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

const flags = ["--planner-model", "faux/strong", "--executor-model", "faux/fast", "--verify", "node verify.js"];

describe("Planner/Executor CLI entry", () => {
	it.each(["--planner-model", "--executor-model", "--verify"])(
		"does not consume a following short option as the value of %s",
		(flag) => {
			for (const [option, property] of [
				["-h", "help"],
				["-p", "print"],
				["-v", "version"],
				["-ne", "noExtensions"],
			] as const) {
				const parsed = parseArgs([flag, option]);
				expect(parsed[property]).toBe(true);
				expect(parsed.diagnostics).toContainEqual({ type: "error", message: `${flag} requires a value` });
				expect(parsed.plannerModel).toBeUndefined();
				expect(parsed.executorModel).toBeUndefined();
				expect(parsed.verificationCommands).toBeUndefined();
			}
		},
	);

	it("keeps acceptance commands and task text separate", () => {
		const parsed = parseArgs([...flags, "--verify", "node check.js", "Fix the parser"]);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.unknownFlags.size).toBe(0);
		expect(parsed.plannerModel).toBe("faux/strong");
		expect(parsed.executorModel).toBe("faux/fast");
		expect(parsed.verificationCommands).toEqual(["node verify.js", "node check.js"]);
		expect(parsed.messages).toEqual(["Fix the parser"]);
	});

	it.each(["--model", "--session", "--workflow-mode"])("rejects conflicting %s", (flag) => {
		expect(parseArgs([...flags, flag, "direct"]).diagnostics).toContainEqual(
			expect.objectContaining({ type: "error" }),
		);
	});

	it.each(["--continue", "--resume", "--no-session"])("rejects %s", (flag) => {
		expect(parseArgs([...flags, flag]).diagnostics).toContainEqual(expect.objectContaining({ type: "error" }));
	});

	it("requires both roles and external acceptance", () => {
		expect(parseArgs(flags.slice(0, 4)).diagnostics).toContainEqual(expect.objectContaining({ type: "error" }));
		expect(parseArgs(["--verify", "--offline"]).diagnostics).toContainEqual(
			expect.objectContaining({ type: "error" }),
		);
		expect(parseArgs(["--workflow-mode", "plan"]).diagnostics).toEqual([]);
	});
});
