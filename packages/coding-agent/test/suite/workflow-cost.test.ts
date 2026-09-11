import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInstance } from "../../src/core/subagents/types.ts";
import { collectWorkflowCost, WORKFLOW_COST_BINDING, WORKFLOW_COST_SCOPE } from "../../src/core/workflow/cost.ts";
import { FULL_PERMISSION_SET } from "../../src/core/workflow/runtime-policy.ts";
import { formatWorkflowProgress } from "../../src/modes/interactive/components/workflow-progress.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Workflow recorded cost", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup() {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						return {
							message: {
								...event.message,
								usage: {
									...event.message.usage,
									cost: { ...event.message.usage.cost, total: 0.125 },
								},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([fauxAssistantMessage("Done"), fauxAssistantMessage("Done again")]);
		await harness.session.prompt("Say done");
		const view = harness.session.getWorkflowView();
		if (!view) throw new Error("Missing Workflow");
		return { ...harness, view };
	}

	it("isolates consecutive task costs and exposes the same total in reports and TUI", async () => {
		const { session, sessionManager, view } = await setup();
		expect(view.cost).toMatchObject({
			totalEstimatedUsd: 0.125,
			estimatedUsd: { execution: 0.125 },
			hostAttributed: true,
		});
		await session.prompt("Say done again");
		const next = session.getWorkflowView()!;
		expect(next.workflow.id).not.toBe(view.workflow.id);
		expect(next.cost?.totalEstimatedUsd).toBe(0.125);
		expect(collectWorkflowCost(sessionManager.getEntries(), view).totalEstimatedUsd).toBe(0.125);
		expect(session.getSessionStats().cost).toBe(0.25);
		expect(session.getWorkflowReportLines()?.filter((line) => line.startsWith("Recorded cost ("))).toHaveLength(1);
		expect(session.getWorkflowReportLines()?.join("\n")).toContain("total $0.125000");
		const active = { ...next, workflow: { ...next.workflow, status: "executing" as const } };
		expect(formatWorkflowProgress(active)[0]).toContain("~$0.125000");
		expect(formatWorkflowProgress(active, true).join("\n")).toContain("execution $0.125000");
	});

	it("keeps summary and post-cut charges once, using persisted scope attribution", async () => {
		const { sessionManager, view } = await setup();
		const assistant = sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("Missing assistant");
		sessionManager.appendCompaction("Summary", assistant.id, 100, undefined, false, assistant.message.usage);
		sessionManager.appendContextWindow({
			schemaVersion: 1,
			windowId: "window-next",
			firstWindowId: "window-first",
			previousWindowId: "window-first",
			windowIndex: 1,
			reason: "manual",
			tokensBefore: 100,
			contextSeed: { schemaVersion: 1, content: "Continue", noteEntryIds: [], truncated: false },
		});
		sessionManager.appendMessage(assistant.message);
		const entries = structuredClone(sessionManager.getEntries());
		expect(collectWorkflowCost([...entries, ...entries], view).estimatedUsd.execution).toBe(0.375);
		const legacy = entries.filter((entry) => entry.type !== "custom" || entry.customType !== WORKFLOW_COST_BINDING);
		expect(collectWorkflowCost(legacy, view)).toMatchObject({ hostAttributed: false, totalEstimatedUsd: 0 });
	});

	it("includes advisor, planning, failed workers, repair and repeated reviews without aggregate duplication", async () => {
		const { sessionManager, view } = await setup();
		const message = sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (message?.type !== "message" || message.message.role !== "assistant") throw new Error("Missing assistant");
		sessionManager.appendCustomEntry(WORKFLOW_COST_SCOPE, { scopeId: "preflight", stage: "other" });
		sessionManager.appendMessage(message.message);
		sessionManager.appendCustomEntry(WORKFLOW_COST_SCOPE, { scopeId: "preflight", stage: "planning" });
		sessionManager.appendMessage(message.message);
		sessionManager.appendCustomEntry(WORKFLOW_COST_BINDING, { scopeId: "preflight", workflowId: view.workflow.id });
		const agent = (id: string, profileName: string, cost: number): AgentInstance => ({
			id,
			profileName,
			workflowId: view.workflow.id,
			taskId: view.tasks[0]!.id,
			attemptId: id,
			scope: "workflow",
			backend: "rpc",
			status: "failed",
			depth: 1,
			retryCount: 0,
			effectivePermissions: FULL_PERMISSION_SET,
			budget: {},
			revision: 1,
			createdAt: "",
			updatedAt: "",
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost,
				turns: 1,
				durationMs: 0,
			},
		});
		const worker = agent("failed-worker", "worker", 0.25);
		const cost = collectWorkflowCost(sessionManager.getEntries(), {
			...view,
			agents: [
				worker,
				{ ...worker, revision: 0, usage: { ...worker.usage, cost: 0.1 } },
				agent("review-1", "reviewer", 0.25),
				agent("review-2", "reviewer", 0.5),
				agent("repair", "repair", 0.25),
				{ ...agent("unrelated", "worker", 10), workflowId: "other" },
			],
		});
		expect(cost.estimatedUsd).toEqual({
			execution: 0.375,
			planning: 0.125,
			other: 0.125,
			review: 0.75,
			repair: 0.25,
		});
		expect(cost.totalEstimatedUsd).toBe(1.625);
	});
});
