import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PROFILES, FULL_PERMISSION_SET, RpcSubagentSessionFactory } from "../../src/index.ts";
import { SUBAGENT_HANDOFF } from "./subagent-fixtures.ts";

const tempDirectories: string[] = [];

function createRpcChild(): string {
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
			"    reply({ id: command.id, type: 'response', command: command.type, success: true, data: { sessionId: 'rpc-' + process.pid + '-' + toolsMode } });",
			"  } else if (command.type === 'get_last_assistant_text') {",
			"    reply({ id: command.id, type: 'response', command: command.type, success: true, data: { text: handoff } });",
			"  } else if (command.type === 'get_session_stats') {",
			"    reply({ id: command.id, type: 'response', command: command.type, success: true, data: { userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, total: 12 }, cost: 0 } });",
			"  } else {",
			"    reply({ id: command.id, type: 'response', command: command.type, success: true });",
			"    if (command.type === 'prompt' || command.type === 'abort') setTimeout(() => reply({ type: 'agent_settled' }), 5);",
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
});

describe("RpcSubagentSessionFactory", () => {
	it("runs an isolated RPC child Session and forwards output and usage", async () => {
		const childPath = createRpcChild();
		const factory = new RpcSubagentSessionFactory({
			command: process.execPath,
			commandArgs: [childPath],
		});
		const session = factory.create({
			cwd: process.cwd(),
			profile: BUILTIN_AGENT_PROFILES.explorer,
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

		expect(await session.getSessionId()).toMatch(/^rpc-\d+-restricted$/);
		expect(await session.getLastAssistantText()).toBe(SUBAGENT_HANDOFF);
		expect(await session.getUsage()).toMatchObject({
			inputTokens: 8,
			outputTokens: 4,
			turns: 1,
		});
		await session.stop();
	});
});
