import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { classifyPierRuntime } from "../../evals/context-window/pier-real-session.ts";
import { createHarness } from "./harness.ts";

const plan = {
	goal: "Remove the disposable fixture",
	assumptions: [],
	steps: [
		{
			id: "check",
			kind: "command",
			command: "check",
			title: "Check fixture",
			description: "Check fixture",
			dependsOn: [],
			fileIntents: [],
			verificationRequirementIds: ["check"],
		},
	],
	risks: [],
	verificationRequirements: [
		{ id: "check", kind: "test", description: "Check passes", command: "check", required: true },
	],
};

describe("Host-authorized isolated Direct execution", () => {
	it("keeps the override local to one prompt and preserves later production approval", async () => {
		const harness = await createHarness();
		try {
			harness.session.enableWorkflowTracking("direct");
			harness.setResponses([
				fauxAssistantMessage("Fixture execution finished."),
				fauxAssistantMessage(JSON.stringify(plan)),
			]);
			await harness.session.prompt("Remove the disposable fixture", {
				isolatedDirectExecution: { reason: "Host owns disposable test sandbox" },
			});
			expect(harness.session.getWorkflowView()?.workflow.modeDecision?.mode).toBe("direct");
			await harness.session.prompt("Remove the disposable fixture");
			expect(harness.session.getWorkflowView()?.workflow).toMatchObject({
				status: "awaiting_approval",
				modeDecision: { source: "forced_policy" },
			});
			expect(
				classifyPierRuntime({
					timedOut: false,
					budgetStopped: false,
					failed: false,
					normalFinal: true,
					workflowStatus: harness.session.getWorkflowView()?.workflow.status,
					clarificationPending: false,
					containerCalls: 0,
					containerReplies: 0,
				}),
			).toBe("waiting_for_approval");
			const calls = harness.faux.state.callCount;
			await expect(
				harness.session.prompt("Continue", { isolatedDirectExecution: { reason: "Cannot approve pending Plan" } }),
			).rejects.toThrow("Isolated Direct");
			expect(harness.faux.state.callCount).toBe(calls);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps every stage of a host-controlled implementation evaluation in Direct mode", async () => {
		const toolRuns: string[] = [];
		const applyBackend: AgentTool = {
			name: "apply_backend",
			label: "Apply backend change",
			description: "Apply a controlled backend fixture change",
			parameters: Type.Object({ target: Type.String() }),
			execute: async (_toolCallId, params) => {
				const target =
					typeof params === "object" && params !== null && "target" in params ? String(params.target) : "";
				toolRuns.push(target);
				return { content: [{ type: "text", text: `changed:${target}` }], details: { target } };
			},
		};
		const harness = await createHarness({ tools: [applyBackend] });
		try {
			harness.session.enableWorkflowTracking("direct");
			harness.setResponses([
				fauxAssistantMessage("Concrete implementation plan."),
				fauxAssistantMessage(fauxToolCall("apply_backend", { target: "pagination" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Backend implementation complete."),
				fauxAssistantMessage("Frontend implementation and verification complete."),
			]);
			const directExecution = {
				isolatedDirectExecution: { reason: "Host-authorized natural context-window calibration" },
			} as const;
			const statuses: string[] = [];

			await harness.session.prompt(
				"Stage 1. Inspect the fixture and prepare a concrete implementation plan.",
				directExecution,
			);
			statuses.push(harness.session.getWorkflowView()?.workflow.status ?? "missing");
			await harness.session.prompt(
				"Stage 2. Continue the approved plan and implement the backend.",
				directExecution,
			);
			statuses.push(harness.session.getWorkflowView()?.workflow.status ?? "missing");
			await harness.session.prompt("Stage 3. Implement the frontend and verify the task.", directExecution);
			statuses.push(harness.session.getWorkflowView()?.workflow.status ?? "missing");

			expect(statuses).toEqual(["completed", "completed", "completed"]);
			expect(toolRuns).toEqual(["pagination"]);
			expect(harness.eventsOfType("workflow_mode_decided").map(({ decision }) => decision.mode)).toEqual([
				"direct",
				"direct",
				"direct",
			]);
			expect(harness.faux.state.callCount).toBe(4);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["disabled", "auto", "automation", "empty-reason", "extension"] as const)(
		"rejects incompatible setup: %s",
		async (setup) => {
			const harness = await createHarness();
			try {
				if (setup !== "disabled")
					harness.session.enableWorkflowTracking(setup === "auto" ? "auto" : "direct", setup === "automation");
				await expect(
					harness.session.prompt("Implement fixture", {
						isolatedDirectExecution: { reason: setup === "empty-reason" ? " " : "Host-owned isolation" },
						...(setup === "extension" ? { source: "extension" as const } : {}),
					}),
				).rejects.toThrow("Isolated Direct");
				expect(harness.faux.state.callCount).toBe(0);
			} finally {
				harness.cleanup();
			}
		},
	);
});
