import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createPlannerExecutorSession } from "../../src/core/planner-executor.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import type { BudgetLimit } from "../../src/core/workflow/types.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const plan = {
	goal: "Fix the fixture",
	assumptions: [],
	risks: [],
	steps: [
		{
			id: "fix",
			kind: "agent",
			requiredAgentRole: "worker",
			title: "Fix fixture",
			description: "Fix fixture",
			dependsOn: [],
			fileIntents: [{ path: "src/file-0.ts", action: "modify", reason: "Fix fixture" }],
			verificationRequirementIds: ["diff"],
		},
	],
	verificationRequirements: [{ id: "diff", kind: "diff", description: "Inspect the change", required: true }],
};

describe("Planner budget through real session entry points", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.abort();
			session.dispose();
		}
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.useRealTimers();
	});

	async function setup(entry: "planner-executor" | "evaluation-sdk", budget: BudgetLimit = {}) {
		const harness = await createHarness({ models: [{ id: "strong" }, { id: "fast" }] });
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, "src"));
		for (let index = 0; index < 16; index++) {
			writeFileSync(join(harness.tempDir, `src/file-${index}.ts`), `export const value = ${index};\n`);
		}
		const common = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
			settingsManager: SettingsManager.inMemory(),
		};
		const { session } =
			entry === "planner-executor"
				? await createPlannerExecutorSession({
						...common,
						plannerModel: "faux/strong",
						executorModel: "faux/fast",
						workflowBudget: budget,
						verificationCommands: ["node verify.js"],
					})
				: await createAgentSession({
						...common,
						model: harness.getModel(),
						tools: ["read", "grep", "find", "ls"],
						modelRoutingUserOverride: false,
						modelRouting: {
							enabled: true,
							policy: "planner_executor",
							fastModel: "faux/fast",
							balancedModel: "faux/strong",
							strongModel: "faux/strong",
						},
					});
		if (entry === "evaluation-sdk") {
			session.enableWorkflowTracking("plan", true, undefined, {
				maxRetries: 0,
				maxConcurrentAgents: 1,
				maxConcurrentJobs: 1,
				...budget,
			});
		}
		sessions.push(session);
		vi.useFakeTimers();
		return { harness, session };
	}

	for (const entry of ["planner-executor", "evaluation-sdk"] as const) {
		it.each([{}, { maxDurationMs: 600_000, maxTurns: 32 }])(
			`${entry}: submits an evidenced plan after 320 seconds and 17 rounds with budget %j`,
			async (budget) => {
				const { harness, session } = await setup(entry, budget);
				const toolsBefore = session.getActiveToolNames();
				harness.setResponses([
					...Array.from({ length: 16 }, (_, index) => async () => {
						await vi.advanceTimersByTimeAsync(20_000);
						return fauxAssistantMessage([fauxToolCall("read", { path: `src/file-${index}.ts` })], {
							stopReason: "toolUse",
						});
					}),
					fauxAssistantMessage(JSON.stringify(plan)),
				]);
				const startedAt = Date.now();
				await session.prompt("Read the fixture and plan its repair");
				expect(Date.now() - startedAt).toBe(320_000);
				expect(harness.faux.state.callCount).toBe(17);
				const view = session.getWorkflowView();
				expect(view?.workflow.status).toBe("awaiting_approval");
				expect(view?.rootTask?.budget.maxDurationMs).toBe(budget.maxDurationMs);
				expect(view?.rootTask?.budget.maxTurns).toBe(budget.maxTurns);
				expect(view?.plan?.steps[0].fileIntents[0].path).toBe("src/file-0.ts");
				expect(view?.agents).toHaveLength(0);
				expect(session.getActiveToolNames()).toEqual(toolsBefore);
				expect(vi.getTimerCount()).toBe(0);
				const recovered = PlanWorkflowRuntime.recoverLatest(session.sessionManager);
				expect(recovered?.tasks.find((task) => task.id === recovered.workflow.rootTaskId)?.budget).toEqual(
					view?.rootTask?.budget,
				);
			},
		);

		it.each([
			{ budget: { maxDurationMs: 1_000 }, delayMs: 2_000, code: "planner.max_duration" },
			{ budget: { maxTurns: 1 }, delayMs: 0, code: "planner.max_turns" },
			{ budget: {}, delayMs: 1_800_001, code: "planner.inactivity" },
		])(`${entry}: honors explicit limits or inactivity: $code`, async ({ budget, delayMs, code }) => {
			const { harness, session } = await setup(entry, budget);
			const toolsBefore = session.getActiveToolNames();
			harness.setResponses(
				Array.from({ length: 3 }, (_, index) => async () => {
					await vi.advanceTimersByTimeAsync(delayMs);
					return fauxAssistantMessage([fauxToolCall("read", { path: `src/file-${index}.ts` })], {
						stopReason: "toolUse",
					});
				}),
			);
			await expect(session.prompt("Investigate the fixture")).rejects.toMatchObject({ code });
			expect(session.getWorkflowView()?.workflow.status).not.toBe("awaiting_approval");
			expect(session.getWorkflowView()?.agents).toHaveLength(0);
			expect(session.isStreaming).toBe(false);
			expect(session.getActiveToolNames()).toEqual(toolsBefore);
			expect(session.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({ customType: "planner_stop", data: expect.objectContaining({ code }) }),
			);
			expect(vi.getTimerCount()).toBe(0);
		});

		it(`${entry}: stops repetitive investigation without publishing a plan`, async () => {
			const { harness, session } = await setup(entry);
			harness.setResponses(
				Array.from({ length: 16 }, () =>
					fauxAssistantMessage([fauxToolCall("read", { path: "src/file-0.ts" })], { stopReason: "toolUse" }),
				),
			);
			await expect(session.prompt("Investigate the fixture")).rejects.toMatchObject({
				code: "planner.repeated_results",
			});
			expect(session.getWorkflowView()?.workflow.status).not.toBe("awaiting_approval");
			expect(session.getWorkflowView()?.agents).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		});
	}
});
