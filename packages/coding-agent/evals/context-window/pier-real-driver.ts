import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ModelRuntime } from "../../src/index.ts";
import { parsePierRunConfig } from "./pier-budget.ts";
import { runPierSession, type ContainerReply } from "./pier-real-session.ts";

const output = process.argv[2];
const configPath = process.argv[3];
const checkpoint = process.argv[5];
if (!output || !configPath || process.argv[4] !== "--execute-paid") throw new Error("Explicit paid execution flag and config required");
const config = parsePierRunConfig(JSON.parse(readFileSync(configPath, "utf8")));
const reader = createInterface({ input: process.stdin });
const lines = reader[Symbol.asyncIterator]();
try {
	const first = await lines.next();
	if (first.done) throw new Error("Missing instruction");
	const input: unknown = JSON.parse(first.value);
	if (!input || typeof input !== "object" || !("instruction" in input) || typeof input.instruction !== "string") throw new Error("Invalid instruction");
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const model = runtime.getModel(config.provider, config.model);
	if (!model || !runtime.hasConfiguredAuth(config.provider)) throw new Error("Configured model/auth unavailable");
	if (model.contextWindow < config.contextWindow || model.maxTokens < config.maxOutputTokens) throw new Error("Model cannot satisfy configured budgets");
	const result = await runPierSession(config, input.instruction, output, runtime, model, async (command) => {
		process.stdout.write(`${JSON.stringify({ type: "exec", command })}\n`);
		const line = await lines.next();
		if (line.done) throw new Error("Bridge closed");
		const reply: unknown = JSON.parse(line.value);
		if (!reply || typeof reply !== "object" || !("stdout" in reply) || typeof reply.stdout !== "string" || !("stderr" in reply) || typeof reply.stderr !== "string" || !("return_code" in reply) || !Number.isInteger(reply.return_code)) throw new Error("Invalid bridge result");
		return reply as ContainerReply;
	}, checkpoint);
	process.stdout.write(`${JSON.stringify({ type: "complete", result })}\n`);
} finally { reader.close(); }
