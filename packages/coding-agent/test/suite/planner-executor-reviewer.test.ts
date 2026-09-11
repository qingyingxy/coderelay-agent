import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { RpcSubagentSessionFactory } from "../../src/core/subagents/rpc-session.ts";
import { BUILTIN_AGENT_PROFILES } from "../../src/core/workflow/agent-profile.ts";
import { createHarness } from "./harness.ts";

it("keeps read-only RPC review and follow-ups out of child Plan approval", async () => {
	const harness = await createHarness();
	const target = join(harness.tempDir, "review-target.txt");
	writeFileSync(target, "review-evidence-741");
	const root = fileURLToPath(new URL("../../../../", import.meta.url));
	const factory = new RpcSubagentSessionFactory({
		command: process.execPath,
		commandArgs: [
			join(root, "node_modules/tsx/dist/cli.mjs"),
			"--tsconfig",
			join(root, "tsconfig.json"),
			fileURLToPath(new URL("./fixtures/planner-executor-reviewer-child.ts", import.meta.url)),
		],
		env: { PI_CODING_AGENT_DIR: join(harness.tempDir, "child-config") },
	});
	const profile = BUILTIN_AGENT_PROFILES.reviewer;
	const session = factory.create({
		cwd: harness.tempDir,
		profile,
		modelName: "faux/strong",
		toolNames: ["read"],
		effectivePermissions: { ...profile.permissionCeiling, write: false, executeCommands: false, network: false },
		budget: { maxDurationMs: 30_000 },
	});
	try {
		await session.start();
		for (const prompt of [
			"Remove the disposable fixture",
			"Remove the disposable fixture; review the change again",
		]) {
			await session.prompt(prompt);
			await session.waitForIdle(30_000);
			expect(await session.getLastAssistantText()).toContain("Read-only review finished");
			expect(readFileSync(target, "utf8")).toBe("review-evidence-741");
		}
		expect((await session.getUsage()).turns).toBe(3);
	} finally {
		await session.stop();
		harness.cleanup();
	}
}, 60_000);

import { readFileSync, writeFileSync } from "node:fs";
