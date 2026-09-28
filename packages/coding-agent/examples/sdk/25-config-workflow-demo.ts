/**
 * Configuration Recovery Showcase
 *
 * Runs a deterministic, no-network Direct workflow against the Faux Provider.
 * Scripted model replies drive real writes, Node tests, a hard context cut,
 * History retrieval and a repair in a temporary workspace.
 * With --automatic, a large local fixture triggers a threshold cut before verification.
 *
 * Run from the repository root:
 *   npx tsx packages/coding-agent/examples/sdk/25-config-workflow-demo.ts
 *   npx tsx packages/coding-agent/examples/sdk/25-config-workflow-demo.ts --interactive
 *   npx tsx packages/coding-agent/examples/sdk/25-config-workflow-demo.ts --automatic --interactive
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
const automatic = process.argv.includes("--automatic");
const log = interactive ? (..._args: unknown[]) => {} : console.log;
let interactiveMode: InteractiveMode | undefined;
const workspace = mkdtempSync(join(tmpdir(), "pi-config-workflow-demo-"));
const demoPath = "src/config.ts";
const initialCode = [
	'import { existsSync, readFileSync } from "node:fs";',
	"export function loadConfig(path: string): { port: number } {",
	'  const source = readFileSync(path, "utf8");',
	"  try { return JSON.parse(source); }",
	'  catch { throw new Error("配置格式错误"); }',
	"}",
].join("\n");
const beforeRepair = '  const source = readFileSync(path, "utf8");';
const afterRepair = `  if (!existsSync(path)) return { port: 3000 };\n${beforeRepair}`;
const request =
	"请给 CLI 增加配置文件读取功能，并验证以下三项：\n1. 读取 JSON 配置\n2. 文件不存在时使用默认端口 3000\n3. 格式错误时给出明确提示";
const faux = registerFauxProvider({
	tokensPerSecond: interactive ? 80 : undefined,
	models: automatic
		? [{ id: "automatic-demo", name: "离线切窗演示", contextWindow: 64000, maxTokens: 4000 }]
		: undefined,
});
let disposeSession: (() => void) | undefined;
const checkResults: number[] = [];
const checkCounts: number[][] = [];

try {
	if (automatic) {
		writeFileSync(
			join(workspace, "reference.txt"),
			`DEMO_REFERENCE_ONLY\n${"Reference entry: configuration loading and compatibility.\n".repeat(4000)}`,
		);
	}
	const inspectReference = defineTool({
		name: "inspect_reference",
		label: "读取演示参考资料",
		description: "Read the large local demo fixture in full to exercise the real context threshold.",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text" as const, text: readFileSync(join(workspace, "reference.txt"), "utf8") }],
			details: {},
		}),
	});
	writeFileSync(
		join(workspace, "config.test.mjs"),
		[
			'import { strict as assert } from "node:assert";',
			'import { test } from "node:test";',
			'import { writeFileSync } from "node:fs";',
			'import { loadConfig } from "./src/config.ts";',
			"Error.stackTraceLimit = 0;",
			'test("读取 JSON 配置", () => { writeFileSync("valid.json", JSON.stringify({ port: 8080 })); assert.deepEqual(loadConfig("valid.json"), { port: 8080 }); });',
			'test("文件不存在时使用默认端口 3000", () => assert.deepEqual(loadConfig("missing.json"), { port: 3000 }));',
			'test("格式错误时给出明确提示", () => { writeFileSync("invalid.json", "{"); assert.throws(() => loadConfig("invalid.json"), /配置格式错误/); });',
		].join("\n"),
	);
	const verifyConfig = defineTool({
		name: "verify_config",
		label: "验证配置读取",
		description: "Run three local Node tests for configuration loading.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		execute: async () => {
			const testEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
			delete testEnv.NO_COLOR;
			const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "config.test.mjs"], {
				cwd: workspace,
				env: testEnv,
				encoding: "utf8",
				timeout: 10_000,
				windowsHide: true,
			});
			if (result.error || result.status === null) throw result.error ?? new Error("Node test did not exit normally");
			checkResults.push(result.status);
			log(`[verify] Node test ${result.status === 0 ? "PASS" : "FAIL (expected before repair)"}`);
			const passed = Number(result.stdout.match(/^# pass (\d+)/m)?.[1]);
			const failed = Number(result.stdout.match(/^# fail (\d+)/m)?.[1]);
			checkCounts.push([passed, failed]);
			assert.equal(passed + failed, 3, "All three fixture checks must execute");
			assert.deepEqual([passed, failed], !automatic && checkResults.length === 1 ? [2, 1] : [3, 0]);
			const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
			const summary = `测试结果：${passed}/3 通过，${failed} 项失败\n${failures.map((name) => `失败：${name}`).join("\n")}`;
			if (result.status !== 0) throw new Error(`CONFIG_CHECK_FAILED\n${summary}`);
			return {
				content: [{ type: "text", text: summary }],
				details: { exitCode: result.status, stdout: result.stdout },
			};
		},
	});
	const model = faux.getModel();
	const responses: FauxResponseStep[] = automatic
		? [
				fauxAssistantMessage(fauxToolCall("write", { path: demoPath, content: initialCode }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						{
							type: "text",
							text: "JSON 读取与错误提示已实现。待办：补上缺失文件默认值，再做一次验收。现在读取演示参考资料，触发真实上下文阈值。",
						},
						fauxToolCall("inspect_reference", {}),
					],
					{ stopReason: "toolUse" },
				),
				(context) => {
					const boundaries = session.sessionManager.getBranch().filter((entry) => entry.type === "context_window");
					assert.equal(boundaries.length, 1);
					assert.equal(boundaries[0]?.reason, "threshold");
					const text = JSON.stringify(context.messages);
					assert.ok(text.includes("Workflow Snapshot is task-control authority"));
					assert.equal(readFileSync(join(workspace, demoPath), "utf8"), initialCode);
					assert.ok(text.includes("默认端口 3000"));
					assert.ok(!text.includes("DEMO_REFERENCE_ONLY"));
					assert.ok(
						session.sessionManager
							.getBranch()
							.some(
								(entry) =>
									entry.type === "message" && JSON.stringify(entry.message).includes("DEMO_REFERENCE_ONLY"),
							),
					);
					log(
						"[context] Automatic threshold cut retained the objective; written code and history remain available",
					);
					return fauxAssistantMessage(
						[
							{
								type: "text",
								text: "已自动进入新上下文，原始目标仍在，代码文件也保留着。继续读取现有实现，补齐默认值，不重新开始。",
							},
							fauxToolCall("read", { path: demoPath }),
						],
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage(
					[
						{ type: "text", text: "沿用现有实现，只补上缺失文件的默认值分支。" },
						fauxToolCall("edit", { path: demoPath, edits: [{ oldText: beforeRepair, newText: afterRepair }] }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("verify_config", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					"任务完成：三项测试全部通过。读取大文件后自动达到切窗阈值，新窗口接着已有代码完成任务。",
				),
			]
		: [
				fauxAssistantMessage(
					fauxToolCall("write", {
						path: demoPath,
						content: initialCode,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("verify_config", {}), { stopReason: "toolUse" }),
				() => {
					assert.deepEqual(checkResults, [1]);
					return fauxAssistantMessage(
						[
							{ type: "text", text: "测试发现问题：缺失配置文件时没有使用默认值。切换上下文后继续修复。" },
							fauxToolCall("new_context", {}),
						],
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const text = JSON.stringify(context.messages);
					assert.ok(text.includes("Workflow Snapshot is task-control authority"));
					assert.ok(text.includes('Observed modification: path=\\"src/config.ts\\" operation=write'));
					assert.ok(
						!context.messages.some(
							(message) => message.role === "toolResult" && message.toolName === "verify_config",
						),
						"Old test result was not excluded by the cut",
					);
					log("[context] Fresh window retains deterministic workflow state; old test output excluded");
					return fauxAssistantMessage(
						[
							{
								type: "text",
								text: "新上下文已建立。待办仍在：修复并重跑三项测试。交接缺少失败用例，按需查询历史验证记录。",
							},
							fauxToolCall("history", { action: "search", query: "失败", tool: "verify_config" }),
						],
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					assert.ok(
						context.messages.some(
							(message) =>
								message.role === "toolResult" &&
								message.toolName === "history" &&
								JSON.stringify(message.content).includes("CONFIG_CHECK_FAILED"),
						),
						"History did not recover the failure",
					);
					log("[history] Recovered the original failing check");
					return fauxAssistantMessage(
						[
							{
								type: "text",
								text: "已从 History 找回失败记录：文件不存在时应返回默认端口 3000。现在补上这个分支。",
							},
							fauxToolCall("edit", { path: demoPath, edits: [{ oldText: beforeRepair, newText: afterRepair }] }),
						],
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage(fauxToolCall("verify_config", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					"配置读取已完成：JSON 读取、缺失文件默认值、格式错误提示，三项测试全部通过。切窗后通过 History 恢复失败记录并完成修复。",
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
		tools: automatic
			? ["read", "edit", "write", "inspect_reference", "verify_config"]
			: ["read", "edit", "write", "new_context", "history", "verify_config"],
		customTools: automatic ? [verifyConfig, inspectReference] : [verifyConfig],
		sessionManager: SessionManager.inMemory(workspace),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: automatic },
			contextManagement: { mode: "windowed", reserveTokens: 16000 },
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
		if (event.type === "tool_execution_end" && event.isError) log(`[tool error] ${JSON.stringify(event.result)}`);
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
	if (!interactive) await session.prompt("/workflow");
	if (interactive) await new Promise((resolve) => setTimeout(resolve, 4000));
	assert.deepEqual(checkResults, automatic ? [0] : [1, 0]);
	assert.deepEqual(
		checkCounts,
		automatic
			? [[3, 0]]
			: [
					[2, 1],
					[3, 0],
				],
	);
	assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);

	const report = session.getLatestWorkflowReport();
	if (!report || report.status !== "completed") {
		throw new Error("Direct Workflow demo did not complete");
	}
	if (report.changedFiles.length !== 1 || report.changedFiles[0] !== demoPath) {
		throw new Error(`Unexpected changed files: ${report.changedFiles.join(", ")}`);
	}

	const finalContent = readFileSync(join(workspace, demoPath), "utf8").trim();
	if (finalContent !== initialCode.replace(beforeRepair, afterRepair)) {
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
