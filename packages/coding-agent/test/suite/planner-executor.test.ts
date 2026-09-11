import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createPlannerExecutorSession } from "../../src/core/planner-executor.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SubagentRuntime } from "../../src/core/subagents/subagent-runtime.ts";
import { ModelGateway } from "../../src/core/workflow/model-gateway.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import { WorkflowRuntimeRegistry } from "../../src/core/workflow/runtime-registry.ts";
import { WriterLeaseRegistry } from "../../src/core/workflow/writer-lease.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { FakeSubagentSessionFactory } from "../workflow/subagent-fixtures.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("serial Planner/Executor entry point", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup() {
		const harness = await createHarness({ models: [{ id: "strong" }, { id: "fast" }] });
		harnesses.push(harness);
		return {
			harness,
			options: {
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				resourceLoader: createTestResourceLoader(),
				sessionManager: SessionManager.inMemory(harness.tempDir),
				settingsManager: SettingsManager.inMemory(),
				plannerModel: "faux/strong",
				executorModel: "faux/fast",
				verificationCommands: ["node verify.js"],
			},
		};
	}

	it("uses a strong read-only Planner and waits for approval with a serial budget", async () => {
		const { harness, options } = await setup();
		const { session } = await createPlannerExecutorSession({
			...options,
			workflowBudget: { maxConcurrentAgents: 8, maxConcurrentJobs: 8, maxCost: 2 },
		});
		sessions.push(session);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
		mkdirSync(join(harness.tempDir, "src"));
		writeFileSync(join(harness.tempDir, "src/index.ts"), "export const value = 0;\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/index.ts" })]),
			fauxAssistantMessage(
				JSON.stringify({
					goal: "Fix the implementation",
					assumptions: ["Preserve the public signature"],
					steps: [
						{
							id: "implement",
							kind: "agent",
							requiredAgentRole: "worker",
							title: "Fix implementation",
							description: "Fix the implementation without changing the signature",
							dependsOn: [],
							fileIntents: [{ path: "src/index.ts", action: "modify", reason: "Fix behavior" }],
							verificationRequirementIds: ["tests"],
						},
					],
					risks: [],
					verificationRequirements: [
						{
							id: "tests",
							kind: "test",
							description: "Pass verification",
							required: true,
							command: "node verify.js",
						},
					],
				}),
			),
		]);
		await session.prompt("Fix the implementation");
		expect(session.model?.id).toBe("strong");
		const view = session.getWorkflowView();
		expect(view?.workflow.status).toBe("awaiting_approval");
		expect(view?.workflow.budget).toMatchObject({
			maxConcurrentAgents: 1,
			maxConcurrentJobs: 1,
			maxRetries: 1,
			maxCost: 2,
		});
		expect(view?.agents).toHaveLength(0);
		expect(view?.modelRoutes).toContainEqual(
			expect.objectContaining({ role: "planner", policy: "planner_executor", modelName: "faux/strong" }),
		);
		const runtime = PlanWorkflowRuntime.recoverLatest(session.sessionManager);
		expect(runtime?.selectDispatches(1)).toHaveLength(0);
		if (!runtime) throw new Error("Plan runtime missing");
		runtime.approve();
		const factory = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: new ModelGateway(harness.session.modelRuntime, {
				enabled: true,
				policy: "planner_executor",
				fastModel: "faux/fast",
				strongModel: "faux/strong",
			}),
		});
		try {
			const executions = await runtime.startReadySubagents(subagents, 1);
			expect(executions).toHaveLength(1);
			expect(factory.sessions[0]?.config.modelName).toBe("faux/fast");
			expect(factory.sessions[0]?.config.toolNames).toEqual(
				expect.arrayContaining(["new_context", "history", "notes"]),
			);
			expect(factory.sessions[0]?.config.contextWindow?.executionContract).toMatchObject({
				planId: runtime.currentPlan.id,
				planVersion: runtime.currentPlan.version,
				attemptId: executions[0]?.agent.attemptId,
			});
			const prompt = factory.sessions[0]?.promptCalls[0] ?? "";
			const contractLine = prompt.split("\n").find((line) => line.startsWith("Execution contract: "));
			expect(JSON.parse(contractLine?.slice("Execution contract: ".length) ?? "null")).toMatchObject({
				planId: runtime.currentPlan.id,
				planVersion: runtime.currentPlan.version,
				attemptId: executions[0]?.agent.attemptId,
				assumptions: ["Preserve the public signature"],
			});
			expect(prompt).toContain("not verification evidence");
			expect(prompt).not.toContain("workflow_prompt_envelope");
			await subagents.interrupt(executions[0]!.agent.id, "Test finished");
			await executions[0]?.completion;
			const retry = await subagents.retry(executions[0]!.agent.id, {
				attemptId: "attempt-next",
				autoStart: false,
				modelEscalationReason: "retry",
			});
			expect(factory.sessions[1]?.config.contextWindow?.executionContract).toMatchObject({
				attemptId: "attempt-next",
				planId: runtime.currentPlan.id,
				planVersion: runtime.currentPlan.version,
			});
			expect(factory.sessions[1]?.config.modelName).toBe("faux/fast");
			expect(retry.sessionId).not.toBe(executions[0]?.agent.sessionId);
		} finally {
			await subagents.dispose();
		}
	});

	it("does not submit a plan or dispatch a Worker when modification evidence is missing", async () => {
		const { harness, options } = await setup();
		const { session } = await createPlannerExecutorSession(options);
		sessions.push(session);
		harness.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					goal: "Fix implementation",
					assumptions: [],
					risks: [],
					verificationRequirements: [],
					steps: [
						{
							id: "fix",
							title: "Fix",
							description: "Fix implementation",
							requiredAgentRole: "worker",
							dependsOn: [],
							fileIntents: [{ path: "src/unread.ts", action: "modify", reason: "Fix behavior" }],
							verificationRequirementIds: [],
						},
					],
				}),
			),
		]);
		await expect(session.prompt("Fix implementation")).rejects.toMatchObject({ code: "planner.evidence_missing" });
		expect(session.getWorkflowView()?.workflow.status).not.toBe("awaiting_approval");
		expect(session.getWorkflowView()?.agents).toHaveLength(0);
		expect(PlanWorkflowRuntime.recoverLatest(session.sessionManager)?.selectDispatches(1)).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rejects missing models, missing checks and non-fresh sessions before execution", async () => {
		const { options } = await setup();
		await expect(createPlannerExecutorSession({ ...options, executorModel: "faux/missing" })).rejects.toThrow(
			"unavailable",
		);
		await expect(createPlannerExecutorSession({ ...options, verificationCommands: [] })).rejects.toThrow(
			"verification commands",
		);
		await expect(createPlannerExecutorSession({ ...options, plannerModel: "strong" })).rejects.toThrow(
			"provider/model",
		);
		options.sessionManager.appendCustomEntry("existing", {});
		await expect(createPlannerExecutorSession(options)).rejects.toThrow("fresh session");
	});

	it("accepts a name on a fresh CLI session", async () => {
		const { options } = await setup();
		options.sessionManager.appendSessionInfo("CLI acceptance");
		const { session } = await createPlannerExecutorSession(options);
		sessions.push(session);
		expect(session.workflowMode).toBe("plan");
	});

	it("keeps planned tiers under budget pressure and escalates only on explicit failure signals", async () => {
		const { harness } = await setup();
		const gateway = new ModelGateway(harness.session.modelRuntime, {
			enabled: true,
			policy: "planner_executor",
			fastModel: "faux/fast",
			strongModel: "faux/strong",
		});
		const pressure = {
			budget: { maxCost: 1 },
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0.9,
				turns: 1,
				durationMs: 0,
			},
		};
		expect(gateway.route({ role: "planner", ...pressure }).record.tier).toBe("strong");
		expect(gateway.route({ role: "worker", ...pressure }).record).toMatchObject({
			tier: "fast",
			policy: "planner_executor",
		});
		expect(gateway.route({ role: "worker", escalationReason: "retry", ...pressure }).record.tier).toBe("fast");
		expect(gateway.route({ role: "worker", escalationReason: "verification_failure", ...pressure }).record.tier).toBe(
			"strong",
		);
		expect(() => gateway.route({ role: "reviewer" })).toThrow("configured balanced model");
		const legacy = new ModelGateway(harness.session.modelRuntime, { enabled: true, balancedModel: "faux/strong" });
		expect(legacy.route({ role: "worker" }).record.tier).toBe("balanced");
	});
});
