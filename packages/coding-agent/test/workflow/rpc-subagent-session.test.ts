import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_PROFILES,
	FULL_PERMISSION_SET,
	RpcSubagentSessionFactory,
	resolveDefaultRpcInvocation,
} from "../../src/index.ts";
import { SUBAGENT_HANDOFF } from "./subagent-fixtures.ts";

const tempDirectories: string[] = [];
const originalSecret = process.env.PI_R14_RPC_SECRET;

function createRpcChild(promptResponseDelayMs = 0, abortResponseDelayMs = 0): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-subagent-rpc-"));
	tempDirectories.push(directory);
	const path = join(directory, "child.mjs");
	writeFileSync(
		path,
		[
			'import { createInterface } from "node:readline";',
			"if (process.env.PI_WORKFLOW_NETWORK_RETRY !== '1') throw new Error('Missing child network policy');",
			`const handoff = ${JSON.stringify(SUBAGENT_HANDOFF)};`,
			"const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
			"createInterface({ input: process.stdin }).on('line', (line) => {",
			"  const command = JSON.parse(line);",
			"  if (command.type === 'get_state') {",
			"    if (process.argv.includes('--context-mode')) {",
			"      const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];",
			"      reply({ id: command.id, type: 'response', command: command.type, success: true, data: { sessionId: JSON.stringify({ mode: value('--context-mode'), sessionDir: value('--session-dir'), ephemeral: process.argv.includes('--no-session'), tools: value('--tools'), model: value('--model') }) } });",
			"      return;",
			"    }",
			"    const toolsMode = process.argv.includes('--tools') ? 'restricted' : process.argv.includes('--no-tools') ? 'none' : 'default';",
			"    const workflowMode = process.argv.includes('--workflow-mode') && process.argv.includes('direct') ? '-direct' : '-auto';",
			"    const modelMode = process.argv.includes('openai/test-model') ? 'model' : 'no-model';",
			"    const thinkingMode = process.argv.includes('high') ? 'high' : process.argv.includes('medium') ? 'medium' : 'no-thinking';",
			"    const envMode = process.env.PI_RPC_ALLOWED === 'yes' ? (process.env.PI_R14_RPC_SECRET ? '-leaked' : '-clean') : '';",
			"    reply({ id: command.id, type: 'response', command: command.type, success: true, data: { thinkingLevel: process.env.PI_TEST_CLAMP || process.argv[process.argv.indexOf('--thinking') + 1], sessionId: 'rpc-' + process.pid + '-' + toolsMode + workflowMode + '-' + modelMode + '-' + thinkingMode + envMode } });",
			"  } else if (command.type === 'get_last_assistant_text') {",
			"    reply({ id: command.id, type: 'response', command: command.type, success: true, data: { text: handoff } });",
			"  } else if (command.type === 'get_session_stats') {",
			"    reply({ id: command.id, type: 'response', command: command.type, success: true, data: { userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, total: 12 }, cost: 0 } });",
			"  } else {",
			`    const responseDelay = command.type === 'prompt' ? ${promptResponseDelayMs} : command.type === 'abort' ? ${abortResponseDelayMs} : 0;`,
			"    setTimeout(() => {",
			"      reply({ id: command.id, type: 'response', command: command.type, success: true });",
			"      if (command.type === 'prompt' || command.type === 'abort') setTimeout(() => reply({ type: 'agent_settled' }), 5);",
			"    }, responseDelay);",
			"  }",
			"});",
		].join("\n"),
	);
	return path;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	if (originalSecret === undefined) {
		delete process.env.PI_R14_RPC_SECRET;
	} else {
		process.env.PI_R14_RPC_SECRET = originalSecret;
	}
});

describe("RpcSubagentSessionFactory", () => {
	it.each(["max", "xhigh"])("checks requested max against actual %s before prompting", async (actual) => {
		const factory = new RpcSubagentSessionFactory({
			command: process.execPath,
			commandArgs: [createRpcChild()],
			thinkingLevel: "max",
			env: { PI_TEST_CLAMP: actual },
		});
		const session = factory.create({
			cwd: process.cwd(),
			profile: BUILTIN_AGENT_PROFILES.explorer,
			toolNames: [],
			effectivePermissions: FULL_PERMISSION_SET,
			budget: {},
		});
		try {
			if (actual === "max") await session.start();
			else await expect(session.start()).rejects.toThrow("thinking level mismatch");
		} finally {
			await session.stop();
		}
	});
	it("passes explicit persistent window settings without changing the model or tools", async () => {
		const factory = new RpcSubagentSessionFactory({ command: process.execPath, commandArgs: [createRpcChild()] });
		const toolNames = ["read", "new_context", "history", "notes"];
		const session = factory.create({
			cwd: process.cwd(),
			profile: BUILTIN_AGENT_PROFILES.worker,
			modelName: "openai/test-model",
			toolNames,
			effectivePermissions: FULL_PERMISSION_SET,
			budget: {},
			contextWindow: { sessionDir: tmpdir() },
		});
		try {
			await session.start();
			expect(JSON.parse(await session.getSessionId())).toEqual({
				mode: "windowed",
				sessionDir: tmpdir(),
				ephemeral: false,
				tools: toolNames.join(","),
				model: "openai/test-model",
			});
		} finally {
			await session.stop();
		}
	});

	it("rejects incomplete window configuration instead of widening permissions", () => {
		const factory = new RpcSubagentSessionFactory();
		const config = {
			cwd: process.cwd(),
			profile: BUILTIN_AGENT_PROFILES.worker,
			toolNames: ["read", "new_context", "history", "notes"],
			effectivePermissions: FULL_PERMISSION_SET,
			budget: {},
			contextWindow: { sessionDir: tmpdir() },
		};
		for (const missing of ["new_context", "history", "notes"]) {
			expect(() =>
				factory.create({ ...config, toolNames: config.toolNames.filter((name) => name !== missing) }),
			).toThrow(missing);
		}
		expect(() => factory.create({ ...config, contextWindow: { sessionDir: "relative" } })).toThrow("absolute");
		expect(() => factory.create({ ...config, profile: BUILTIN_AGENT_PROFILES.explorer })).toThrow("Worker");
		expect(() =>
			factory.create({ ...config, effectivePermissions: { ...FULL_PERMISSION_SET, read: false } }),
		).toThrow("read permission");
	});

	it("launches the repository CLI when an SDK script runs under Node", () => {
		const invocation = resolveDefaultRpcInvocation({
			currentScript: join(process.cwd(), "examples", "sdk", "evaluation.ts"),
			currentModule: join(process.cwd(), "src", "core", "subagents", "rpc-session.ts"),
			execPath: process.execPath,
			execArgv: ["--import", "tsx"],
		});

		expect(invocation).toEqual({
			command: process.execPath,
			commandArgs: ["--import", "tsx", join(process.cwd(), "src", "cli.ts")],
		});
	});

	it("runs an isolated RPC child Session and forwards output and usage", async () => {
		const childPath = createRpcChild();
		const factory = new RpcSubagentSessionFactory({
			command: process.execPath,
			commandArgs: [childPath],
		});
		const session = factory.create({
			cwd: process.cwd(),
			profile: {
				...BUILTIN_AGENT_PROFILES.explorer,
				model: "openai/test-model",
				thinkingLevel: "high",
			},
			toolNames: ["read", "grep"],
			effectivePermissions: {
				...FULL_PERMISSION_SET,
				write: false,
				executeCommands: false,
				network: false,
			},
			budget: { maxTurns: 4 },
		});

		await session.start();
		const idle = session.waitForIdle(2_000);
		await session.prompt("Inspect the repository");
		await idle;

		expect(await session.getSessionId()).toMatch(/^rpc-\d+-restricted-direct-model-high$/);
		expect(await session.getLastAssistantText()).toBe(SUBAGENT_HANDOFF);
		expect(await session.getUsage()).toMatchObject({
			inputTokens: 8,
			outputTokens: 4,
			turns: 1,
		});
		await session.stop();
	});

	it("applies a factory thinking level when the Profile does not override it", async () => {
		const childPath = createRpcChild();
		const factory = new RpcSubagentSessionFactory({
			command: process.execPath,
			commandArgs: [childPath],
			thinkingLevel: "medium",
		});
		const session = factory.create({
			cwd: process.cwd(),
			profile: BUILTIN_AGENT_PROFILES.explorer,
			toolNames: [],
			effectivePermissions: {
				...FULL_PERMISSION_SET,
				write: false,
				executeCommands: false,
				network: false,
			},
			budget: {},
		});

		await session.start();
		expect(await session.getSessionId()).toMatch(/-medium$/);
		await session.stop();
	});

	it("uses an explicit minimal environment without inheriting unrelated secrets", async () => {
		const childPath = createRpcChild();
		process.env.PI_R14_RPC_SECRET = "must-not-leak";
		const factory = new RpcSubagentSessionFactory({
			command: process.execPath,
			commandArgs: [childPath],
		});
		const environment: Record<string, string> = { PI_RPC_ALLOWED: "yes" };
		for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
			const value = process.env[key];
			if (value) {
				environment[key] = value;
			}
		}
		const session = factory.create({
			cwd: process.cwd(),
			profile: BUILTIN_AGENT_PROFILES.explorer,
			toolNames: [],
			effectivePermissions: {
				...FULL_PERMISSION_SET,
				write: false,
				executeCommands: false,
				network: false,
			},
			budget: {},
			environment,
		});

		await session.start();
		expect(await session.getSessionId()).toMatch(/-clean$/);
		await session.stop();
	});

	it("uses the Agent duration budget for RPC prompt responses", async () => {
		const childPath = createRpcChild(50);
		const factory = new RpcSubagentSessionFactory({
			command: process.execPath,
			commandArgs: [childPath],
		});
		const session = factory.create({
			cwd: process.cwd(),
			profile: BUILTIN_AGENT_PROFILES.explorer,
			toolNames: [],
			effectivePermissions: {
				...FULL_PERMISSION_SET,
				write: false,
				executeCommands: false,
				network: false,
			},
			budget: { maxDurationMs: 10 },
		});

		await session.start();
		await expect(session.prompt("Inspect")).rejects.toThrow("Timeout waiting for response to prompt");
		await session.stop();
	});

	it("force-stops the RPC process when abort acknowledgement hangs", async () => {
		const childPath = createRpcChild(0, 60_000);
		const factory = new RpcSubagentSessionFactory({
			command: process.execPath,
			commandArgs: [childPath],
		});
		const session = factory.create({
			cwd: process.cwd(),
			profile: BUILTIN_AGENT_PROFILES.explorer,
			toolNames: [],
			effectivePermissions: {
				...FULL_PERMISSION_SET,
				write: false,
				executeCommands: false,
				network: false,
			},
			budget: { maxDurationMs: 60_000 },
		});

		await session.start();
		const idle = session.waitForIdle(0);
		const rejected = expect(idle).rejects.toThrow(/exited|stopped/);
		const startedAt = Date.now();
		await session.abort();
		await rejected;

		expect(Date.now() - startedAt).toBeLessThan(3_000);
	});
});
