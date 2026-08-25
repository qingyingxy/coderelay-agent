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
			`const handoff = ${JSON.stringify(SUBAGENT_HANDOFF)};`,
			"const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
			"createInterface({ input: process.stdin }).on('line', (line) => {",
			"  const command = JSON.parse(line);",
			"  if (command.type === 'get_state') {",
			"    const toolsMode = process.argv.includes('--tools') ? 'restricted' : process.argv.includes('--no-tools') ? 'none' : 'default';",
			"    const workflowMode = process.argv.includes('--workflow-mode') && process.argv.includes('direct') ? '-direct' : '-auto';",
			"    const modelMode = process.argv.includes('openai/test-model') ? 'model' : 'no-model';",
			"    const thinkingMode = process.argv.includes('high') ? 'high' : process.argv.includes('medium') ? 'medium' : 'no-thinking';",
			"    const envMode = process.env.PI_RPC_ALLOWED === 'yes' ? (process.env.PI_R14_RPC_SECRET ? '-leaked' : '-clean') : '';",
			"    reply({ id: command.id, type: 'response', command: command.type, success: true, data: { sessionId: 'rpc-' + process.pid + '-' + toolsMode + workflowMode + '-' + modelMode + '-' + thinkingMode + envMode } });",
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
		const startedAt = Date.now();
		await session.abort();

		expect(Date.now() - startedAt).toBeLessThan(3_000);
	});
});
