/** Offline Planner/Executor showcase: real Plan, RPC Worker, file edit and Node acceptance. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentInstance,
	type AgentRunResult,
	CurrentWorkspaceProvider,
	createAgentSession,
	createExtensionRuntime,
	createPlannerExecutorSession,
	ModelGateway,
	ModelRuntime,
	type PlanContent,
	PlanWorkflowRuntime,
	type ResourceLoader,
	RpcSubagentSessionFactory,
	SessionManager,
	SettingsManager,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "@earendil-works/pi-coding-agent";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { main } from "../../src/main.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

const workerProcess = process.argv.includes("--worker-process");
const interactive = process.argv.includes("--interactive");
let interactiveMode: InteractiveMode | undefined;
const paced = process.argv.includes("--record");
const modelDefinitions = [
	{ id: "planner-demo", name: "Planner（离线预设）", contextWindow: 128000, maxTokens: 4000 },
	{ id: "executor-demo", name: "Executor（离线预设）", contextWindow: 128000, maxTokens: 4000 },
];
const faux = registerFauxProvider({ models: modelDefinitions });
const original = "export function defaultPort(value) { return value || 3000; }\n";
const fixed = "export function defaultPort(value) { return value ?? 3000; }\n";

if (workerProcess) {
	faux.setResponses([
		(context, _options, _state, model) => {
			assert.equal(model.id, "executor-demo");
			assert.ok(context.systemPrompt?.includes("Parent execution contract"));
			return fauxAssistantMessage(
				fauxToolCall("edit", {
					path: "src/config.mjs",
					edits: [{ oldText: original.trim(), newText: fixed.trim() }],
				}),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			JSON.stringify({
				conclusion: "默认端口逻辑已修改，保留显式传入的 0。",
				evidence: [{ path: "src/config.mjs", note: "只将 || 替换为 ??" }],
				architectureFindings: [],
				changedFiles: ["src/config.mjs"],
				verificationSummary: ["实现已完成，等待父运行时验收。"],
				risks: [],
				unfinishedItems: [],
			}),
		),
	]);
	await main(["--offline", "--no-extensions", "--no-skills", "--no-context-files", ...process.argv.slice(3)], {
		extensionFactories: [
			(pi) => {
				const model = faux.getModel();
				pi.registerProvider(model.provider, {
					api: faux.api,
					apiKey: "faux-key",
					baseUrl: model.baseUrl,
					models: faux.models.map((entry) => ({ ...entry })),
				});
			},
		],
	});
} else {
	const workspace = mkdtempSync(join(tmpdir(), "pi-planner-executor-demo-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(workspace, "agent");
	let disposeSession: (() => void) | undefined;
	let subagents: SubagentRuntime | undefined;
	const show = async (title: string, lines: readonly string[]) => {
		if (interactive) return;
		if (paced) process.stdout.write("\x1b[2J\x1b[H");
		console.log(
			`CodeRelay Agent | Planner / Executor\n离线预设模型 · 真实 RPC 会话、文件修改与 Node 验收\n\n${title}\n\n${lines.join("\n")}\n`,
		);
		if (paced) await new Promise((resolve) => setTimeout(resolve, 2500));
	};
	try {
		mkdirSync(join(workspace, "src"));
		writeFileSync(join(workspace, "src/config.mjs"), original);
		writeFileSync(
			join(workspace, "verify.cjs"),
			[
				"const assert = require('node:assert/strict');",
				"const { test } = require('node:test');",
				"test('missing port uses 3000', async () => assert.equal((await import('./src/config.mjs')).defaultPort(undefined), 3000));",
				"test('explicit zero is preserved', async () => assert.equal((await import('./src/config.mjs')).defaultPort(0), 0));",
				"test('custom port is preserved', async () => assert.equal((await import('./src/config.mjs')).defaultPort(8080), 8080));",
			].join("\n"),
		);
		const command = "node --test --test-reporter=tap verify.cjs";
		const planContent: PlanContent = {
			goal: "修复默认端口逻辑：保留显式传入的 0",
			assumptions: ["仅修改 src/config.mjs，保持函数签名"],
			risks: [],
			steps: [
				{
					id: "fix",
					kind: "agent",
					requiredAgentRole: "worker",
					title: "修复默认端口逻辑",
					description: "将 || 替换为 ??，仅为空值使用默认端口。",
					dependsOn: [],
					fileIntents: [{ path: "src/config.mjs", action: "modify", reason: "保留合法的零值" }],
					verificationRequirementIds: ["tests"],
				},
			],
			verificationRequirements: [
				{ id: "tests", kind: "test", description: "三个端口用例通过", required: true, command },
			],
		};
		faux.setResponses([
			(_context, _options, _state, model) => {
				assert.equal(model.id, "planner-demo");
				return fauxAssistantMessage(fauxToolCall("read", { path: "src/config.mjs" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(JSON.stringify(planContent)),
		]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(workspace, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: faux.models.map((entry) => ({ ...entry })),
		});
		await modelRuntime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });
		const loader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => "Produce the fixed demo Plan after inspecting the file.",
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};
		let verificationRuns = 0;
		subagents = new SubagentRuntime({
			sessionFactory: new RpcSubagentSessionFactory({
				command: process.execPath,
				commandArgs: [
					fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
					"--tsconfig",
					fileURLToPath(new URL("../../../../tsconfig.json", import.meta.url)),
					fileURLToPath(import.meta.url),
					"--worker-process",
				],
				env: { PI_CODING_AGENT_DIR: join(workspace, "agent"), PI_OFFLINE: "1" },
				systemPromptFile: join(workspace, "worker-prompt.txt"),
			}),
			workspaceProvider: new CurrentWorkspaceProvider(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			modelGateway: new ModelGateway(modelRuntime, {
				enabled: true,
				policy: "planner_executor",
				fastModel: "faux/executor-demo",
				strongModel: "faux/planner-demo",
			}),
			verificationRunner: async (input) => {
				assert.equal(input.command, command);
				const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "verify.cjs"], {
					cwd: input.cwd,
					env: { ...input.environment, FORCE_COLOR: "0" },
					encoding: "utf8",
					windowsHide: true,
					timeout: input.timeoutMs,
				});
				assert.ifError(result.error);
				assert.equal(result.status, 0, result.stdout + result.stderr);
				assert.match(result.stdout, /# pass 3/);
				verificationRuns++;
				return { exitCode: result.status ?? undefined, output: result.stdout + result.stderr, timedOut: false };
			},
		});
		const sessionOptions = {
			cwd: workspace,
			agentDir: join(workspace, "agent"),
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(workspace),
			settingsManager: SettingsManager.inMemory(),
		};
		const { session } = interactive
			? await createAgentSession({
					...sessionOptions,
					subagentRuntime: subagents,
					modelRoutingUserOverride: false,
					modelRouting: {
						enabled: true,
						policy: "planner_executor",
						fastModel: "faux/executor-demo",
						balancedModel: "faux/planner-demo",
						strongModel: "faux/planner-demo",
					},
				})
			: await createPlannerExecutorSession({
					...sessionOptions,
					plannerModel: "faux/planner-demo",
					executorModel: "faux/executor-demo",
					verificationCommands: [command],
				});
		if (interactive) {
			process.env.PI_OFFLINE = "1";
			session.enableWorkflowTracking("plan", false, undefined, undefined, [command]);
			interactiveMode = new InteractiveMode(
				new AgentSessionRuntime(
					session,
					{
						...sessionOptions,
						diagnostics: [],
					},
					async () => {
						throw new Error("Session replacement is outside this demo");
					},
				),
			);
			await interactiveMode.init();
			await session.prompt("/plan");
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		disposeSession = () => session.dispose();
		session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.isError) console.error(JSON.stringify(event.result));
		});
		await show("01 需求交给 Planner", [
			"任务：默认端口逻辑不能把显式的 0 当成缺失值。",
			"Planner 只读检查代码，然后给出执行范围。",
			"模型：faux/planner-demo（预设回复，不代表模型能力）",
		]);
		await session.prompt(planContent.goal);
		const workflow = PlanWorkflowRuntime.recoverLatest(session.sessionManager);
		assert.ok(workflow);
		assert.equal(workflow.workflow.status, "awaiting_approval");
		assert.equal(workflow.selectDispatches(1).length, 0);
		assert.equal(readFileSync(join(workspace, "src/config.mjs"), "utf8"), original);
		await show("02 计划待批准：尚未修改文件", [
			`目标：${workflow.currentPlan.goal}`,
			...workflow.currentPlan.assumptions,
			...workflow.currentPlan.steps.map((step) => `执行：${step.description}`),
			"验收：默认值 / 显式 0 / 自定义端口",
			"审批动作由演示脚本模拟。",
		]);
		if (interactive) {
			await session.prompt("/plan");
			await new Promise((resolve) => setTimeout(resolve, 3500));
			await session.prompt("/approve");
		} else workflow.approve("Offline demo approval, simulated by the script");
		await show("03 批准后交给 Executor", [
			"独立 RPC 子进程 / 独立会话",
			"路由目标：faux/executor-demo",
			"交接：计划版本、文件范围、实现要求、验收命令",
			"本例使用同一个临时目录，不演示 Git Worktree 隔离。",
		]);
		let agent: AgentInstance;
		let result: AgentRunResult;
		if (interactive) {
			await session.prompt("/agents dispatch 1");
			[agent] = subagents.list(workflow.workflow.id);
			assert.ok(agent);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			await session.prompt(`/agent wait ${agent.id}`);
			result = await subagents.wait(agent.id);
			await new Promise((resolve) => setTimeout(resolve, 3500));
		} else {
			const [execution] = await workflow.startReadySubagents(subagents, 1);
			assert.ok(execution);
			agent = execution.agent;
			result = await execution.completion;
		}
		assert.equal(agent.modelRoute?.modelName, "faux/executor-demo");
		assert.notEqual(agent.sessionId, session.sessionManager.getSessionId());
		assert.equal(result.status, "completed", result.error);
		assert.equal(readFileSync(join(workspace, "src/config.mjs"), "utf8"), fixed);
		assert.equal(verificationRuns, 1);
		assert.equal(
			(PlanWorkflowRuntime.recoverLatest(session.sessionManager) ?? workflow).tasks.find(
				(task) => task.sourcePlanStepId === "fix",
			)?.status,
			"succeeded",
		);
		await show("04 Executor 完成实现", [
			`实际模型路由：${agent.modelRoute?.modelName}`,
			"实际文件差异：",
			`- ${original.trim()}`,
			`+ ${fixed.trim()}`,
			`交回结果：${result.handoff?.conclusion}`,
		]);
		await show("05 父运行时验收通过", [
			"三个真实 Node 用例：3/3 通过",
			`执行验收命令次数：${verificationRuns}`,
			"Worker 任务状态：succeeded",
			"演示到 Worker 交付为止；未运行最终 Delivery / Reviewer。",
			"无外部模型调用，不展示虚构的费用节省。",
		]);
		interactiveMode?.stop();
		console.log("[demo] PASS");
	} finally {
		interactiveMode?.stop();
		await subagents?.dispose();
		disposeSession?.();
		faux.unregister();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
}
