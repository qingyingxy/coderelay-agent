import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RpcSubagentSessionFactory } from "../../src/core/subagents/rpc-session.ts";
import { BUILTIN_AGENT_PROFILES } from "../../src/core/workflow/agent-profile.ts";
import { FULL_PERMISSION_SET } from "../../src/core/workflow/runtime-policy.ts";

it("starts RPC with a large intact system prompt stored outside command-line arguments", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-prompt-"));
	const child = join(dir, "child.mjs");
	const promptFile = join(dir, "prompt.txt");
	writeFileSync(
		child,
		[
			'import { createInterface } from "node:readline";',
			'createInterface({input:process.stdin}).on("line", line => {',
			"const c = JSON.parse(line);",
			'process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data:{sessionId:JSON.stringify(process.argv.slice(2))}})+"\\n");',
			"});",
		].join("\n"),
	);
	const text = "Long worker handoff. ".repeat(3000);
	const factory = new RpcSubagentSessionFactory({
		command: process.execPath,
		commandArgs: [child],
		systemPromptFile: promptFile,
	});
	const session = factory.create({
		cwd: dir,
		profile: { ...BUILTIN_AGENT_PROFILES.worker, systemPrompt: text },
		toolNames: ["read"],
		effectivePermissions: FULL_PERMISSION_SET,
		budget: {},
	});
	try {
		await session.start();
		const args: string[] = JSON.parse(await session.getSessionId());
		expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(promptFile);
		expect(args.join(" ").length).toBeLessThan(1000);
		expect(readFileSync(promptFile, "utf8")).toContain(text.trim());
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
