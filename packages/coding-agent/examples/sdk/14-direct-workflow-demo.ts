/**
 * Direct Workflow Demo
 *
 * Runs a deterministic, no-network Direct workflow against the Faux Provider.
 * Scripted model replies drive real writes, Node tests, a hard context cut,
 * History retrieval and a repair in a temporary workspace.
 *
 * Run from the repository root:
 *   npm run demo:direct-workflow
 *   npm run demo:direct-workflow -- --interactive
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

const interactive = process.argv.includes("--interactive");
const log = interactive ? (..._args: unknown[]) => {} : console.log;
let interactiveMode: InteractiveMode | undefined;
const workspace = mkdtempSync(join(tmpdir(), "pi-direct-workflow-demo-"));
const demoPath = "src/greeting.ts";
const request = "请创建 src/greeting.ts，将问候语从 hello 改为 hello workflow，并运行测试验证。";
const faux = registerFauxProvider({ tokensPerSecond: interactive ? 80 : undefined });
let disposeSession: (() => void) | undefined;
const checkResults: number[] = [];

try {
	writeFileSync(
		join(workspace, "greeting.test.mjs"),
		[
			'import { strict as assert } from "node:assert";',
			'import { test } from "node:test";',
			'import { greeting } from "./src/greeting.ts";',
			"Error.stackTraceLimit = 0;",
			'test("greeting meets the requested value", () => assert.equal(greeting, "hello workflow"));',
		].join("\n"),
	);
	const verifyGreeting = defineTool({
		name: "verify_greeting",
		label: "Verify greeting",
		description: "Run the fixed local Node test for the requested greeting.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		execute: async () => {
			const testEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
			delete testEnv.NO_COLOR;
			const result = spawnSync(process.execPath, ["--test", "greeting.test.mjs"], {
				cwd: workspace,
				env: testEnv,
				encoding: "utf8",
				timeout: 10_000,
				windowsHide: true,
			});
			if (result.error || result.status === null) throw result.error ?? new Error("Node test did not exit normally");
			checkResults.push(result.status);
			log(`[verify] Node test ${result.status === 0 ? "PASS" : "FAIL (expected before repair)"}`);
			if (result.status !== 0) throw new Error(`GREETING_CHECK_FAILED\n${result.stdout}\n${result.stderr}`);
			return { content: [{ type: "text", text: result.stdout }], details: { exitCode: result.status } };
		},
	});
	const model = faux.getModel();
	const responses: FauxResponseStep[] = [
		fauxAssistantMessage(
			fauxToolCall("write", {
				path: demoPath,
				content: 'export const greeting = "hello";\n',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("verify_greeting", {}), { stopReason: "toolUse" }),
		() => {
			assert.deepEqual(checkResults, [1]);
			return fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" });
		},
		(context) => {
			const text = JSON.stringify(context.messages);
			assert.ok(text.includes("Workflow Snapshot is task-control authority"));
			assert.ok(text.includes('Observed modification: path=\\"src/greeting.ts\\" operation=write'));
			assert.ok(
				!context.messages.some(
					(message) => message.role === "toolResult" && message.toolName === "verify_greeting",
				),
				"Old test result was not excluded by the cut",
			);
			log("[context] Fresh window retains deterministic workflow state; old test output excluded");
			return fauxAssistantMessage(
				fauxToolCall("history", { action: "search", query: "GREETING_CHECK_FAILED", tool: "verify_greeting" }),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			assert.ok(
				context.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "history" &&
						JSON.stringify(message.content).includes("GREETING_CHECK_FAILED"),
				),
				"History did not recover the failure",
			);
			log("[history] Recovered the original failing check");
			return fauxAssistantMessage(
				fauxToolCall("edit", { path: demoPath, edits: [{ oldText: '"hello"', newText: '"hello workflow"' }] }),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(fauxToolCall("verify_greeting", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(
			"Updated src/greeting.ts to hello workflow. The Node test now passes after recovering the failed check from History.",
		),
	];
	faux.setResponses(
		responses.map((step) => async (...args) => {
			if (interactive) await new Promise((resolve) => setTimeout(resolve, 2000));
			return typeof step === "function" ? step(...args) : step;
		}),
	);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(workspace, "auth.json"),
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
		tools: ["read", "edit", "write", "new_context", "history", "verify_greeting"],
		customTools: [verifyGreeting],
		sessionManager: SessionManager.inMemory(workspace),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			contextManagement: { mode: "windowed" },
			retry: { enabled: false },
		}),
	});
	disposeSession = () => session.dispose();
	session.enableWorkflowTracking("direct");
	if (interactive) {
		process.env.PI_OFFLINE = "1";
		interactiveMode = new InteractiveMode(
			new AgentSessionRuntime(
				session,
				{
					cwd: workspace,
					agentDir: workspace,
					modelRuntime,
					settingsManager: session.settingsManager,
					resourceLoader,
					diagnostics: [],
				},
				async () => {
					throw new Error("Session replacement is outside this fixed demo");
				},
			),
		);
		await interactiveMode.init();
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}

	session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			log(`[tool] ${event.toolName}`);
		}
		if (
			event.type === "message_start" &&
			event.message.role === "custom" &&
			event.message.customType === "workflow" &&
			typeof event.message.content === "string"
		) {
			log(event.message.content);
		}
	});

	log("[demo] Offline scripted model; real file tools and Node tests; no API key required");
	log(`[request] ${request}`);
	await session.prompt(request);
	if (interactive) await new Promise((resolve) => setTimeout(resolve, 4000));
	await session.prompt("/workflow");
	if (interactive) await new Promise((resolve) => setTimeout(resolve, 4000));
	assert.deepEqual(checkResults, [1, 0]);
	assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);

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
	log(`[file] ${demoPath}: ${finalContent}`);
} finally {
	interactiveMode?.stop();
	disposeSession?.();
	faux.unregister();
	rmSync(workspace, { recursive: true, force: true });
}
console.log("[demo] PASS");
