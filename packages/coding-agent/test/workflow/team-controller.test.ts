import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	SessionWorkflowEventLog,
	WorkflowController,
	WorkflowControllerError,
	WorkflowStore,
} from "../../src/core/workflow/index.ts";
import { NOW } from "./fixtures.ts";

function approvedController(): WorkflowController {
	let sequence = 0;
	const controller = new WorkflowController(
		new SessionWorkflowEventLog(SessionManager.inMemory()),
		new WorkflowStore(),
		{
			createId: (kind) => `${kind}-${++sequence}`,
			now: () => NOW,
		},
	);
	controller.startPlan({
		commandId: "start",
		workflowId: "workflow-team",
		rootTaskId: "task-root",
		planId: "plan-team",
		request: { text: "Implement a parser change", cwd: "C:/repo", attachments: [] },
		budget: { maxTurns: 40 },
	});
	controller.submitPlanForApproval({
		commandId: "submit",
		workflowId: "workflow-team",
		planId: "plan-team",
		plannerReadOnly: true,
		content: {
			goal: "Implement parser change",
			assumptions: [],
			steps: [
				{
					id: "step-inspect",
					title: "Inspect parser",
					description: "Inspect parser ownership",
					dependsOn: [],
					fileIntents: [{ path: "src/parser.ts", action: "inspect", reason: "Locate ownership" }],
					verificationRequirementIds: ["verify-parser"],
				},
			],
			risks: [],
			verificationRequirements: [
				{
					id: "verify-parser",
					kind: "test",
					description: "Run parser tests",
					required: true,
				},
			],
		},
	});
	controller.approvePlan({
		commandId: "approve",
		workflowId: "workflow-team",
		planId: "plan-team",
		comment: "Approved",
	});
	return controller;
}

describe("WorkflowController Team Task admission", () => {
	it("materializes an accepted proposal as an authoritative Task with inherited governance", () => {
		const controller = approvedController();
		const dependency = controller.listTasks("workflow-team").find(({ kind }) => kind === "agent");
		expect(dependency).toBeDefined();

		controller.createProposedTask({
			commandId: "accept-proposal",
			workflowId: "workflow-team",
			proposalId: "proposal-1",
			taskId: "task-proposal",
			sourceAgentId: "agent-explorer",
			parentTaskId: dependency!.id,
			title: "Review parser evidence",
			description: "Review the evidence before implementation",
			dependencyIds: [dependency!.id],
			accessMode: "read_only",
			requiredAgentRole: "reviewer",
			riskLevel: "medium",
			highRiskApproved: false,
			verification: {
				kind: "review",
				description: "Return evidence-backed findings",
			},
		});

		expect(controller.getTask("task-proposal")).toMatchObject({
			workflowId: "workflow-team",
			parentTaskId: dependency!.id,
			sourcePlanId: "plan-team",
			sourceProposalId: "proposal-1",
			recommendedAgentRole: "reviewer",
			status: "pending",
			accessMode: "read_only",
			dependencyIds: [dependency!.id],
			budget: { maxTurns: 8 },
		});
	});

	it("rejects high-risk, duplicate, and role-escalating proposal admission", () => {
		const controller = approvedController();
		const dependency = controller.listTasks("workflow-team").find(({ kind }) => kind === "agent");
		const base = {
			workflowId: "workflow-team",
			sourceAgentId: "agent-explorer",
			parentTaskId: dependency!.id,
			title: "Modify parser",
			description: "Modify parser ownership",
			dependencyIds: [dependency!.id],
			accessMode: "writer" as const,
			requiredAgentRole: "worker" as const,
			riskLevel: "high" as const,
			verification: { kind: "test" as const, description: "Run parser tests" },
		};

		expect(() =>
			controller.createProposedTask({
				...base,
				commandId: "high-risk-without-approval",
				proposalId: "proposal-high",
				taskId: "task-high",
				highRiskApproved: false,
			}),
		).toThrowError(expect.objectContaining({ code: "controller.proposal_approval_required" }));
		expect(() =>
			controller.createProposedTask({
				...base,
				commandId: "wrong-role",
				proposalId: "proposal-role",
				taskId: "task-role",
				accessMode: "read_only",
				highRiskApproved: true,
			}),
		).toThrowError(expect.objectContaining({ code: "controller.proposal_read_only_role" }));

		controller.createProposedTask({
			...base,
			commandId: "accepted",
			proposalId: "proposal-high",
			taskId: "task-high",
			highRiskApproved: true,
		});
		expect(() =>
			controller.createProposedTask({
				...base,
				commandId: "duplicate",
				proposalId: "proposal-high",
				taskId: "task-duplicate",
				highRiskApproved: true,
			}),
		).toThrow(WorkflowControllerError);
	});
});
