import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PierControlledReplay } from "../evals/context-window/pier-controlled-replay.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(branch = "task-branch") {
	const directory = mkdtempSync(join(tmpdir(), "pi-controlled-"));
	directories.push(directory);
	mkdirSync(join(directory, "C"));
	const raw = [
		{ type: "message", message: { role: "user", content: "Original requirement" } },
		{
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "read-1", name: "container_exec", arguments: { command: "read fixture" } },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "container_exec",
				content: [{ type: "text", text: "Cached result" }],
				details: { return_code: 0 },
			},
		},
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n");
	writeFileSync(join(directory, "C/session.jsonl"), raw);
	writeFileSync(
		join(directory, "checkpoint.json"),
		JSON.stringify({ sessionSha256: createHash("sha256").update(raw).digest("hex") }),
	);
	writeFileSync(
		join(directory, "repository.json"),
		JSON.stringify({ base: "a".repeat(40), tree: "b".repeat(40), branch }),
	);
	return directory;
}

describe("controlled Pier replay guards", () => {
	it("serves only matching cached results and gates new commands until maintenance", () => {
		const directory = fixture();
		const replay = new PierControlledReplay(directory, "C", directory, "Original requirement");
		expect(() => replay.toolResult("other", "read fixture")).toThrow();
		expect(() => replay.toolResult("read-1", "different command")).toThrow();
		expect(replay.replayResults).toBe(0);
		expect(replay.toolResult("read-1", "read fixture")?.content).toEqual([{ type: "text", text: "Cached result" }]);
		expect(() => replay.toolResult("new", "write fixture")).toThrow("before controlled maintenance");
		replay.continued = true;
		expect(replay.toolResult("new", "write fixture")).toBeUndefined();
	});

	it("rejects a changed requirement or altered frozen session", () => {
		const directory = fixture();
		expect(() => new PierControlledReplay(directory, "C", directory, "Other requirement")).toThrow();
		writeFileSync(join(directory, "C/session.jsonl"), "changed");
		expect(() => new PierControlledReplay(directory, "C", directory, "Original requirement")).toThrow();
	});

	it("rejects shell syntax in the restore branch", () => {
		const directory = fixture("task'; unexpected");
		expect(() => new PierControlledReplay(directory, "C", directory, "Original requirement")).toThrow();
	});
});
