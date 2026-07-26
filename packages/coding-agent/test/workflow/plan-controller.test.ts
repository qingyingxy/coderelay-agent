import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { PlanContent } from "../../src/core/workflow/index.ts";
import {
	SessionWorkflowEventLog,
	WorkflowController,
	WorkflowControllerError,
	WorkflowStore,
} from "../../src/core/workflow/index.ts";
import { NOW } from "./fixtures.ts";

const WORKFLOW_ID = "workflow-plan";
const ROOT_TASK_ID = "task-root";
const PLAN_ID = "plan-1";

function content(): PlanContent {
	return {
		goal: "Implement formal Plan Mode",
		assumptions: ["Workflow Event Log remains authoritative"],
		steps: [
			{
				id: "step-1",
				title: "Add Plan commands",
				description: "Implement Plan lifecycle commands",
				dependsOn: [],
				fileIntents: [
					{
						path: "src/plan.ts",
						action: "modify",
						reason: "Add Plan lifecycle",
					},
				],
				verificationRequirementIds: ["verify-plan"],
			},
			{
				id: "step-2",
				title: "Test Plan commands",
				description: "Cover approval and revision",
				dependsOn: ["step-1"],
				fileIntents: [
					{
						path: "test/plan.test.ts",
						action: "create",
						reason: "Add regression coverage",
					},
				],
				verificationRequirementIds: ["verify-plan"],
			},
		],
		risks: [
			{
				level: "medium",
				description: "Approval state could diverge",
				mitigation: "Persist all decisions in the Workflow Event Log",
			},
		],
		verificationRequirements: [
			{
				id: "verify-plan",
				kind: "test",
				description: "Run Plan tests",
				required: true,
			},
		],
	};
}

function harness() {
	let sequence = 0;
	const session = SessionManager.inMemory();
	const eventLog = new SessionWorkflowEventLog(session);
	const store = new WorkflowStore();
	const controller = new WorkflowController(eventLog, store, {
		createId: (kind) => `${kind}-${++sequence}`,
		now: () => NOW,
	});
	return { controller, eventLog, store };
}

function start(controller: WorkflowController): void {
	controller.startPlan({
		commandId: "start-plan",
		workflowId: WORKFLOW_ID,
		rootTaskId: ROOT_TASK_ID,
		planId: PLAN_ID,
		request: {
			text: "Plan a multi-file CLI change",
			cwd: "C:/repo",
			attachments: [],
		},
	});
}

function submit(controller: WorkflowController): void {
	controller.submitPlanForApproval({
		commandId: "submit-plan",
		workflowId: WORKFLOW_ID,
		planId: PLAN_ID,
		content: content(),
		plannerReadOnly: true,
	});
}

describe("Plan WorkflowController", () => {
	it("starts a Plan workflow with a Draft Plan and control root Task", () => {
		const { controller, store } = harness();

		const result = controller.startPlan({
			commandId: "start-plan",
			workflowId: WORKFLOW_ID,
			rootTaskId: ROOT_TASK_ID,
			planId: PLAN_ID,
			request: {
				text: "Plan a multi-file CLI change",
				cwd: "C:/repo",
				attachments: [],
			},
		});

		expect(result).toMatchObject({
			workflow: {
				status: "planning",
				modeDecision: { mode: "plan", source: "user" },
				currentPlanId: PLAN_ID,
			},
			rootTask: {
				kind: "control",
				status: "pending",
			},
			currentPlan: {
				status: "draft",
				version: 1,
			},
		});
		expect(store.getLastSequence(WORKFLOW_ID)).toBe(6);
	});

	it("requires valid content and a read-only Planner before requesting approval", () => {
		const { controller, eventLog, store } = harness();
		start(controller);
		const batchCount = eventLog.read().length;

		expect(() =>
			controller.submitPlanForApproval({
				commandId: "invalid-plan",
				workflowId: WORKFLOW_ID,
				planId: PLAN_ID,
				content: { ...content(), steps: [] },
				plannerReadOnly: true,
			}),
		).toThrow(WorkflowControllerError);
		expect(() =>
			controller.submitPlanForApproval({
				commandId: "writing-planner",
				workflowId: WORKFLOW_ID,
				planId: PLAN_ID,
				content: content(),
				plannerReadOnly: false,
			}),
		).toThrow(WorkflowControllerError);

		expect(eventLog.read()).toHaveLength(batchCount);
		expect(store.getWorkflow(WORKFLOW_ID)?.status).toBe("planning");
		expect(store.getPlan(PLAN_ID)?.status).toBe("draft");
	});

	it("approves a Plan, records the decision, and materializes its Task graph", () => {
		const { controller, store } = harness();
		start(controller);
		submit(controller);

		controller.approvePlan({
			commandId: "approve-plan",
			workflowId: WORKFLOW_ID,
			planId: PLAN_ID,
			comment: "Approved after review",
		});

		expect(store.getWorkflow(WORKFLOW_ID)?.status).toBe("executing");
		expect(store.getPlan(PLAN_ID)).toMatchObject({
			status: "approved",
			decisionHistory: [
				{
					action: "approved",
					comment: "Approved after review",
					decidedAt: NOW,
				},
			],
		});
		const stepTasks = store.listTasks(WORKFLOW_ID).filter(({ sourcePlanId }) => sourcePlanId === PLAN_ID);
		expect(stepTasks).toHaveLength(2);
		const first = stepTasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "step-1");
		const second = stepTasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "step-2");
		expect(first).toMatchObject({
			parentTaskId: ROOT_TASK_ID,
			title: "Add Plan commands",
			status: "pending",
		});
		expect(second?.dependencyIds).toEqual([first?.id]);
		expect(second?.verificationRequirements.map(({ id }) => id)).toEqual(["verify-plan"]);
	});

	it("rejects a Plan with an immutable decision and cancels the Workflow", () => {
		const { controller, store } = harness();
		start(controller);
		submit(controller);

		controller.rejectPlan({
			commandId: "reject-plan",
			workflowId: WORKFLOW_ID,
			planId: PLAN_ID,
			comment: "The requested approach is too risky",
		});

		expect(store.getPlan(PLAN_ID)).toMatchObject({
			status: "rejected",
			decisionHistory: [{ action: "rejected", comment: "The requested approach is too risky" }],
		});
		expect(store.getTask(ROOT_TASK_ID)?.status).toBe("cancelled");
		expect(store.getWorkflow(WORKFLOW_ID)).toMatchObject({
			status: "cancelled",
			result: {
				reason: "The requested approach is too risky",
			},
		});
	});

	it("creates a new Draft version without overwriting the superseded Plan", () => {
		const { controller, store } = harness();
		start(controller);
		submit(controller);

		controller.revisePlan({
			commandId: "revise-plan",
			workflowId: WORKFLOW_ID,
			planId: PLAN_ID,
			replacementPlanId: "plan-2",
			comment: "Split the second step",
		});

		expect(store.getPlan(PLAN_ID)).toMatchObject({
			status: "superseded",
			decisionHistory: [{ action: "revision_requested", comment: "Split the second step" }],
		});
		expect(store.getPlan("plan-2")).toMatchObject({
			status: "draft",
			version: 2,
			supersedesPlanId: PLAN_ID,
			goal: "Implement formal Plan Mode",
			decisionHistory: [],
		});
		expect(store.getWorkflow(WORKFLOW_ID)).toMatchObject({
			status: "planning",
			currentPlanId: "plan-2",
		});
	});
});
