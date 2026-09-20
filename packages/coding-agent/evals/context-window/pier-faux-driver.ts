/** No-network SDK smoke; all target-repository commands cross the Pier bridge. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
	createAgentSession, createExtensionRuntime, defineTool, getHistoryResultCount,
	ModelRuntime, type ResourceLoader, SessionManager, SettingsManager,
} from "../../src/index.ts";

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const output = process.argv[2];
if (!output) throw new Error("Missing log directory");
mkdirSync(output, { recursive: true });
const initial = await lines.next();
if (initial.done) throw new Error("Missing instruction");
const input: unknown = JSON.parse(initial.value);
if (!input || typeof input !== "object" || !("instruction" in input) || typeof input.instruction !== "string") {
	throw new Error("Invalid instruction");
}
const tool = defineTool({
	name: "container_exec", label: "Container", description: "Execute a command in the isolated task container.",
	parameters: Type.Object({ command: Type.String() }),
	execute: async (_id, params) => {
		process.stdout.write(`${JSON.stringify({ type: "exec", command: params.command })}\n`);
		const line = await lines.next();
		if (line.done) throw new Error("Bridge closed");
		const result: unknown = JSON.parse(line.value);
		if (!result || typeof result !== "object" || !("return_code" in result) || result.return_code !== 0) {
			throw new Error(`Container command failed: ${line.value}`);
		}
		return { content: [{ type: "text", text: line.value }], details: undefined };
	},
});
const resources: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => "Transport smoke only. Commit the harmless fixture patch inside /app.",
	getAppendSystemPrompt: () => [], extendResources: () => {}, reload: async () => {},
};
const faux = registerFauxProvider({ models: [{ id: "pier-smoke", contextWindow: 64000, maxTokens: 4000 }] });
const model = faux.getModel();
const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
await runtime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });
const manager = SessionManager.create(output, join(output, "sessions"));
const { session } = await createAgentSession({
	cwd: output, agentDir: output, modelRuntime: runtime, model, thinkingLevel: "off",
	tools: ["container_exec", "history", "notes", "new_context"], customTools: [tool], resourceLoader: resources, sessionManager: manager,
	settingsManager: SettingsManager.inMemory({
		compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16000 },
		contextManagement: { mode: "windowed", reserveTokens: 16000, notesHintMaxBytes: 4000, historyResultMaxBytes: 16000 },
		retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 30000 } },
	}),
});
session.subscribe((event) => appendFileSync(join(output, "events.jsonl"), `${JSON.stringify(event)}\n`));
try {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("container_exec", { command: "git rev-parse HEAD && test ! -e /tests/test.sh && test ! -S /var/run/docker.sock" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("notes", { action: "upsert", category: "constraint", note_id: "smoke", content: "transport-marker-20260906: harmless transport smoke only" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Boundary completed."),
	]);
	await session.prompt(input.instruction);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("history", { action: "search", query: "transport-marker-20260906" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("container_exec", { command: "printf 'Pi SDK transport smoke only. No feature implementation.\\n' > PI_TRANSPORT_SMOKE.txt && git add PI_TRANSPORT_SMOKE.txt && git -c user.name=PiSmoke -c user.email=pi-smoke@example.invalid commit -m 'Transport smoke fixture' && git show --stat --oneline HEAD" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Transport fixture committed; functional reward is expected to be zero."),
	]);
	await session.prompt("Recover the smoke marker from History and submit the transport fixture.");
	const windows = manager.getBranch().filter((entry) => entry.type === "context_window");
	const historyCount = getHistoryResultCount(manager.queryHistory({ action: "search", query: "transport-marker-20260906" }, 16000));
	const errors = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError);
	const passed = windows.length === 1 && historyCount > 0 && errors.length === 0;
	writeFileSync(join(output, "sdk-result.json"), JSON.stringify({ passed, provider: "faux", costUsd: 0, windows: windows.length, historyCount, toolErrors: errors.length, qualityEvaluation: false }, null, 2));
	if (!passed) throw new Error("SDK lifecycle smoke failed");
	process.stdout.write(`${JSON.stringify({ type: "complete" })}\n`);
} finally {
	session.dispose();
	faux.unregister();
	await lines.return?.();
}
