/**
 * Direct Workflow Demo
 *
 * Runs a deterministic, no-network Direct workflow against the Faux Provider.
 * The agent writes and edits one temporary file, then prints the authoritative
 * Workflow report exposed by the CLI core.
 *
 * Run from the repository root:
 *   npm run demo:direct-workflow
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const workspace = mkdtempSync(join(tmpdir(), "pi-direct-workflow-demo-"));
const demoPath = "src/greeting.ts";
const request = "Create src/greeting.ts, then change its greeting from hello to hello workflow.";
const faux = registerFauxProvider();
let disposeSession: (() => void) | undefined;

try {
	const model = faux.getModel();
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", {
				path: demoPath,
				content: 'export const greeting = "hello";\n',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("edit", {
				path: demoPath,
				edits: [{ oldText: '"hello"', newText: '"hello workflow"' }],
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Created and updated the greeting file."),
	]);

	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	await modelRuntime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Execute the fixed Direct workflow demo.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const { session } = await createAgentSession({
		cwd: workspace,
		agentDir: workspace,
		model,
		modelRuntime,
		resourceLoader,
		tools: ["read", "edit", "write"],
		sessionManager: SessionManager.inMemory(workspace),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});
	disposeSession = () => session.dispose();
	session.enableWorkflowTracking();

	session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			console.log(`[tool] ${event.toolName}`);
		}
		if (
			event.type === "message_start" &&
			event.message.role === "custom" &&
			event.message.customType === "workflow" &&
			typeof event.message.content === "string"
		) {
			console.log(event.message.content);
		}
	});

	console.log(`[request] ${request}`);
	await session.prompt(request);
	await session.prompt("/workflow");

	const report = session.getLatestWorkflowReport();
	if (!report || report.status !== "completed") {
		throw new Error("Direct Workflow demo did not complete");
	}
	if (report.changedFiles.length !== 1 || report.changedFiles[0] !== demoPath) {
		throw new Error(`Unexpected changed files: ${report.changedFiles.join(", ")}`);
	}

	const finalContent = readFileSync(join(workspace, demoPath), "utf8").trim();
	if (finalContent !== 'export const greeting = "hello workflow";') {
		throw new Error(`Unexpected file content: ${finalContent}`);
	}
	console.log(`[file] ${demoPath}: ${finalContent}`);
	console.log("[demo] PASS");
} finally {
	disposeSession?.();
	faux.unregister();
	rmSync(workspace, { recursive: true, force: true });
}
