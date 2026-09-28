import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPlannerExecutorSession } from "../../src/core/planner-executor.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { RpcSubagentSessionFactory } from "../../src/core/subagents/rpc-session.ts";
import { SubagentRuntime } from "../../src/core/subagents/subagent-runtime.ts";
import type { SubagentSessionConfig } from "../../src/core/subagents/types.ts";
import { CurrentWorkspaceProvider } from "../../src/core/subagents/workspace-provider.ts";
import { ModelGateway } from "../../src/core/workflow/model-gateway.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import { WorkflowRuntimeRegistry } from "../../src/core/workflow/runtime-registry.ts";
import { WriterLeaseRegistry } from "../../src/core/workflow/writer-lease.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness } from "./harness.ts";

describe("Planner to RPC Worker hard windows", () => {
	it.each([false, true])(
		"retains the contract across two cuts; model omits verification=%s",
		async (modelOmitsVerification) => {
			const harness = await createHarness({ models: [{ id: "strong" }, { id: "fast" }] });
			const sessionDir = join(harness.tempDir, "worker-sessions");
			writeFileSync(join(harness.tempDir, "evidence.txt"), "evidence-secret-741");
			writeFileSync(
				join(harness.tempDir, "verify.cjs"),
				"const fs = require('node:fs'); if (fs.readFileSync('result.txt', 'utf8') !== 'fixed') process.exit(1); fs.appendFileSync('verified.txt', 'checked\\n');",
			);
			const { session } = await createPlannerExecutorSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				resourceLoader: createTestResourceLoader(),
				sessionManager: SessionManager.inMemory(harness.tempDir),
				settingsManager: SettingsManager.inMemory(),
				plannerModel: "faux/strong",
				executorModel: "faux/fast",
				verificationCommands: ["node verify.cjs"],
				workflowBudget: { maxRetries: 0 },
			});
			const root = fileURLToPath(new URL("../../../../", import.meta.url));
			const rpcFactory = new RpcSubagentSessionFactory({
				command: process.execPath,
				commandArgs: [
					join(root, "node_modules/tsx/dist/cli.mjs"),
					"--tsconfig",
					join(root, "tsconfig.json"),
					fileURLToPath(new URL("./fixtures/planner-executor-rpc-child.ts", import.meta.url)),
				],
				env: {
					PI_CODING_AGENT_DIR: join(harness.tempDir, "child-config"),
					PI_WORKER_TEST_UNVERIFIED: modelOmitsVerification ? "1" : "0",
				},
			});
			const configs: SubagentSessionConfig[] = [];
			const subagents = new SubagentRuntime({
				sessionFactory: {
					create(config) {
						configs.push(config);
						expect(config.contextWindow?.executionContract).toBeDefined();
						return rpcFactory.create({ ...config, contextWindow: { ...config.contextWindow!, sessionDir } });
					},
				},
				workspaceProvider: new CurrentWorkspaceProvider(),
				runtimeRegistry: new WorkflowRuntimeRegistry(),
				writerLeaseRegistry: new WriterLeaseRegistry(),
				maxAgentDurationMs: 60_000,
				modelGateway: new ModelGateway(harness.session.modelRuntime, {
					enabled: true,
					policy: "planner_executor",
					fastModel: "faux/fast",
					strongModel: "faux/strong",
				}),
			});
			try {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
					fauxAssistantMessage(
						JSON.stringify({
							goal: "Fix fixture behavior",
							assumptions: ["Preserve public behavior"],
							steps: [
								{
									id: "fix",
									kind: "agent",
									requiredAgentRole: "worker",
									title: "Fix fixture",
									description: "Write result.txt",
									dependsOn: [],
									fileIntents: [{ path: "result.txt", action: "create", reason: "Fix output" }],
									verificationRequirementIds: ["tests"],
								},
							],
							risks: [],
							verificationRequirements: [
								{
									id: "tests",
									kind: "test",
									description: "Check output",
									required: true,
									command: "node verify.cjs",
								},
							],
						}),
					),
				]);
				await session.prompt("Fix fixture behavior");
				expect(session.model?.id).toBe("strong");
				const plan = PlanWorkflowRuntime.recoverLatest(session.sessionManager)!;
				expect(plan.workflow.status).toBe("awaiting_approval");
				await expect(plan.startReadySubagents(subagents, 1)).rejects.toThrow("not executing");
				expect(configs).toHaveLength(0);
				plan.approve();
				const [execution] = await plan.startReadySubagents(subagents, 1);
				expect(execution).toBeDefined();
				const result = await execution!.completion;
				expect(result.status, result.error).toBe("completed");
				expect(configs).toHaveLength(1);
				expect(configs[0]?.modelName).toBe("faux/fast");
				expect(configs[0]?.contextWindow?.executionContract).toMatchObject({
					planId: plan.currentPlan.id,
					planVersion: plan.currentPlan.version,
					attemptId: execution!.agent.attemptId,
					taskId: execution!.agent.taskId,
				});
				expect(plan.attempts.filter(({ taskId }) => taskId === execution!.agent.taskId)).toHaveLength(1);
				expect(plan.workflow.status).not.toBe("completed");
				expect(
					plan.verifications.filter(
						({ requirementId, status }) => requirementId === "tests" && status === "passed",
					),
				).toEqual([]);
				const [file] = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
				expect(file).toBeDefined();
				const persisted = SessionManager.open(resolve(sessionDir, file!));
				const cuts = persisted.getEntries().filter((entry) => entry.type === "context_window");
				expect(cuts).toHaveLength(2);
				for (const cut of cuts) {
					const serialized = JSON.stringify(cut);
					expect(serialized).toContain('Observed modification: path=\\"result.txt\\" operation=write');
					expect(serialized).toContain("Fixture compatibility constraint");
					expect(serialized).not.toContain("Keep the original fixture behavior; tests not yet run");
				}
				expect(
					persisted.queryHistory(
						{ action: "search", query: "evidence-secret-741", role: "toolResult", tool: "read" },
						16000,
					),
				).toMatchObject({
					matches: [expect.objectContaining({ snippet: expect.stringContaining("evidence-secret-741") })],
				});
				expect(
					persisted
						.getEntries()
						.filter(
							(entry) =>
								entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
						),
				).toEqual([]);
				expect(readFileSync(join(harness.tempDir, "verified.txt"), "utf8").trim().split("\n")).toHaveLength(
					modelOmitsVerification ? 1 : 2,
				);
			} finally {
				await subagents.dispose();
				session.dispose();
				harness.cleanup();
			}
		},
		90_000,
	);
});
