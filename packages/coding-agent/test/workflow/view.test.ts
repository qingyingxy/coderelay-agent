import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type PlanContent, PlanWorkflowRuntime } from "../../src/index.ts";

const CONTENT: PlanContent = {
	goal: "Exercise the structured Workflow view",
	assumptions: [],
	steps: [
		{
			id: "inspect",
			title: "Inspect",
			description: "Inspect the CLI",
			dependsOn: [],
			fileIntents: [],
			verificationRequirementIds: ["manual"],
		},
		{
			id: "check",
			kind: "command",
			command: "npm run check",
			title: "Check",
			description: "Run checks",
			dependsOn: [],
			fileIntents: [],
			verificationRequirementIds: ["manual"],
		},
	],
	risks: [],
	verificationRequirements: [
		{
			id: "manual",
			kind: "manual",
			description: "Task completes",
			required: true,
		},
	],
};

describe("WorkflowView", () => {
	it("derives approval and execution controls from authoritative state", () => {
		const runtime = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
			workflowId: "workflow-view",
			rootTaskId: "task-root",
			planId: "plan-view",
			request: {
				text: "Exercise the structured Workflow view",
				cwd: "C:/repo",
				attachments: [],
			},
		});
		runtime.submit(CONTENT);

		const approvalView = runtime.view();
		expect(approvalView.availableActions).toEqual(["approve", "reject", "replan", "cancel"]);
		expect(approvalView.rootTask?.id).toBe("task-root");
		expect(approvalView.statusLine).toContain("root: task-root");

		runtime.approve();
		const executionView = runtime.view();
		expect(executionView.availableActions).toEqual(
			expect.arrayContaining(["dispatch_agents", "dispatch_jobs", "cancel"]),
		);
		expect(executionView.tasks.filter(({ kind }) => kind !== "control")).toHaveLength(2);
		expect(executionView.schemaVersion).toBe(1);
		expect(JSON.parse(JSON.stringify(executionView))).toMatchObject({
			workflow: { id: "workflow-view", status: "executing" },
			plan: { id: "plan-view", status: "approved" },
		});
	});
});
