import { describe, expect, it } from "vitest";
import {
	createEvaluationBashToolDefinition,
	EVALUATION_SHELL_TIMEOUT_SECONDS,
	evaluationShellPolicyViolation,
} from "../../src/core/evaluation/shell-policy.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";

describe("evaluation shell policy", () => {
	it("rejects recursive searches from Unix and Windows filesystem roots", () => {
		for (const command of [
			"find / -path '*/proxy-addr/index.js'",
			'find / -name "di" -maxdepth 6 -type d',
			"find C:/ -name package.json",
			'powershell -Command "Get-ChildItem -Path C:\\ -Recurse"',
			"rg package.json /",
		]) {
			expect(evaluationShellPolicyViolation(command), command).toBeDefined();
		}
	});

	it("allows searches scoped to the current repository", () => {
		expect(evaluationShellPolicyViolation("find . -name package.json")).toBeUndefined();
		expect(evaluationShellPolicyViolation("rg package.json .")).toBeUndefined();
	});

	it("applies the default timeout and caps a requested timeout", async () => {
		const observedTimeouts: Array<number | undefined> = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, { timeout }) => {
				observedTimeouts.push(timeout);
				return { exitCode: 0 };
			},
		};
		const tool = createEvaluationBashToolDefinition(process.cwd(), {
			exposeSessionEnvironment: false,
			operations,
		});

		await tool.execute(
			"default-timeout",
			{ command: "find . -name package.json" },
			undefined,
			undefined,
			{} as never,
		);
		await tool.execute(
			"capped-timeout",
			{ command: "find . -name package.json", timeout: 300 },
			undefined,
			undefined,
			{} as never,
		);
		await tool.execute(
			"short-timeout",
			{ command: "find . -name package.json", timeout: 5 },
			undefined,
			undefined,
			{} as never,
		);

		expect(observedTimeouts).toEqual([EVALUATION_SHELL_TIMEOUT_SECONDS, EVALUATION_SHELL_TIMEOUT_SECONDS, 5]);
	});

	it("rejects a root search before starting the command", async () => {
		let started = false;
		const operations: BashOperations = {
			exec: async () => {
				started = true;
				return { exitCode: 0 };
			},
		};
		const tool = createEvaluationBashToolDefinition(process.cwd(), {
			exposeSessionEnvironment: false,
			operations,
		});

		await expect(
			tool.execute("root-search", { command: "find / -name package.json" }, undefined, undefined, {} as never),
		).rejects.toThrow(/Evaluation shell policy rejected/);
		expect(started).toBe(false);
	});
});
