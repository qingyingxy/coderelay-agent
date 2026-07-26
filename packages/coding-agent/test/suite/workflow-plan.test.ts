import { existsSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContent } from "../../src/core/workflow/index.ts";
import { SessionWorkflowEventLog, WorkflowStore } from "../../src/core/workflow/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function planContent(goal: string, secondTitle = "Add tests"): PlanContent {
	return {
		goal,
		assumptions: ["The current CLI architecture remains in place"],
		steps: [
			{
				id: "step-1",
				title: "Implement Plan lifecycle",
				description: "Add the Plan lifecycle to the Workflow Controller",
				dependsOn: [],
				fileIntents: [
					{
						path: "src/plan.ts",
						action: "modify",
						reason: "Implement Plan lifecycle",
					},
				],
				verificationRequirementIds: ["verify-plan"],
			},
			{
				id: "step-2",
				title: secondTitle,
				description: "Add regression coverage for Plan lifecycle",
				dependsOn: ["step-1"],
				fileIntents: [
					{
						path: "test/plan.test.ts",
						action: "create",
						reason: "Cover Plan lifecycle",
					},
				],
				verificationRequirementIds: ["verify-plan"],
			},
		],
		risks: [
			{
				level: "medium",
				description: "Approval state could diverge",
				mitigation: "Persist decisions in the Workflow Event Log",
			},
		],
		verificationRequirements: [
			{
				id: "verify-plan",
				kind: "test",
				description: "Run Plan regression tests",
				required: true,
			},
		],
	};
}

function replay(harness: Harness): {
	readonly store: WorkflowStore;
	readonly workflowId: string;
} {
	const batches = new SessionWorkflowEventLog(harness.sessionManager).read();
	const workflowId = batches[0]?.batch.workflowId;
	if (!workflowId) {
		throw new Error("Expected a Plan Workflow");
	}
	const store = new WorkflowStore();
	store.replay(batches);
	return { store, workflowId };
}

describe("Plan Workflow AgentSession integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs a read-only Planner, waits for approval, then materializes Tasks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(planContent("Implement formal Plan Mode")))]);
		let plannerToolNames: string[] = [];
		const streamFunction = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			plannerToolNames = (context.tools ?? []).map(({ name }) => name);
			return streamFunction(model, context, options);
		};

		await harness.session.prompt("/plan");
		expect(harness.faux.state.callCount).toBe(0);
		await harness.session.prompt("Plan a multi-file CLI change");

		let replayed = replay(harness);
		let workflow = replayed.store.getWorkflow(replayed.workflowId);
		const plan = workflow?.currentPlanId ? replayed.store.getPlan(workflow.currentPlanId) : undefined;
		expect(plannerToolNames).not.toContain("bash");
		expect(plannerToolNames).not.toContain("edit");
		expect(plannerToolNames).not.toContain("write");
		expect(workflow?.status).toBe("awaiting_approval");
		expect(plan).toMatchObject({
			status: "awaiting_approval",
			goal: "Implement formal Plan Mode",
		});
		expect(existsSync(`${harness.tempDir}/src/plan.ts`)).toBe(false);

		await harness.session.prompt("/approve reviewed");

		replayed = replay(harness);
		workflow = replayed.store.getWorkflow(replayed.workflowId);
		const tasks = replayed.store
			.listTasks(replayed.workflowId)
			.filter(({ sourcePlanId }) => sourcePlanId === workflow?.currentPlanId);
		expect(workflow?.status).toBe("executing");
		expect(tasks).toHaveLength(2);
		expect(replayed.store.getPlan(workflow?.currentPlanId ?? "")).toMatchObject({
			status: "approved",
			decisionHistory: [{ action: "approved", comment: "reviewed" }],
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("creates a new Plan version for replan and preserves the old decision history", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([
			fauxAssistantMessage(JSON.stringify(planContent("Initial Plan"))),
			fauxAssistantMessage(JSON.stringify(planContent("Revised Plan", "Split integration tests"))),
		]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Plan a risky CLI change");
		await harness.session.prompt("/replan Split the test work");
		await harness.session.prompt("Use separate unit and integration tests");

		const { store, workflowId } = replay(harness);
		const plans = store.listPlans(workflowId);
		expect(plans).toHaveLength(2);
		expect(plans[0]).toMatchObject({
			status: "superseded",
			decisionHistory: [{ action: "revision_requested", comment: "Split the test work" }],
		});
		expect(plans[1]).toMatchObject({
			status: "awaiting_approval",
			version: 2,
			supersedesPlanId: plans[0]?.id,
			goal: "Revised Plan",
		});
		expect(store.getWorkflow(workflowId)?.currentPlanId).toBe(plans[1]?.id);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("rejects the current Plan without another provider call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(planContent("Rejected Plan")))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Plan a CLI change");
		await harness.session.prompt("/reject Too risky");

		const { store, workflowId } = replay(harness);
		const workflow = store.getWorkflow(workflowId);
		expect(workflow).toMatchObject({
			status: "cancelled",
			result: {
				reason: "Too risky",
			},
		});
		expect(store.getPlan(workflow?.currentPlanId ?? "")).toMatchObject({
			status: "rejected",
			decisionHistory: [{ action: "rejected", comment: "Too risky" }],
		});
		expect(harness.faux.state.callCount).toBe(1);

		await harness.session.prompt("/workflow");
		const message = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.slice()
			.reverse()
			.find((candidate) => candidate.role === "custom" && candidate.customType === "workflow");
		expect(getMessageText(message)).toContain("plan | cancelled | Plan v1: rejected");
	});

	it("shows the Task tree and supports Task inspection and cancellation without provider calls", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(planContent("Task CLI")))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Plan a Task CLI change");
		await harness.session.prompt("/approve");
		let replayed = replay(harness);
		const planId = replayed.store.getWorkflow(replayed.workflowId)?.currentPlanId;
		const firstTask = replayed.store
			.listTasks(replayed.workflowId)
			.find(({ sourcePlanId, sourcePlanStepId }) => sourcePlanId === planId && sourcePlanStepId === "step-1");
		const secondTask = replayed.store
			.listTasks(replayed.workflowId)
			.find(({ sourcePlanId, sourcePlanStepId }) => sourcePlanId === planId && sourcePlanStepId === "step-2");
		if (!firstTask || !secondTask) {
			throw new Error("Expected materialized Plan Tasks");
		}

		await harness.session.prompt("/tasks");
		await harness.session.prompt(`/task show ${firstTask.id}`);
		await harness.session.prompt(`/task cancel ${firstTask.id} Superseded`);

		const workflowMessages = harness
			.eventsOfType("message_end")
			.map(({ message }) => message)
			.filter((message) => message.role === "custom" && message.customType === "workflow");
		expect(workflowMessages.map(getMessageText).join("\n")).toContain("Dispatchable:");
		expect(workflowMessages.map(getMessageText).join("\n")).toContain(`Task ${firstTask.id}`);
		replayed = replay(harness);
		expect(replayed.store.getTask(firstTask.id)?.status).toBe("cancelled");
		expect(replayed.store.getTask(secondTask.id)).toMatchObject({
			status: "blocked",
			blockedReason: { code: "dependency_failed" },
		});
		expect(harness.faux.state.callCount).toBe(1);
	});
});
