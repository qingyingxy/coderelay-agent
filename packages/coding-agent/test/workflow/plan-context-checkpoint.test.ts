import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { WORKFLOW_SNAPSHOT_CUSTOM_TYPE } from "../../src/core/workflow/event-log.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";

describe("PlanWorkflowRuntime context checkpoint", () => {
	it("returns the Snapshot and the exact Session Entry that persisted it", () => {
		const session = SessionManager.inMemory("C:/repo");
		const runtime = PlanWorkflowRuntime.start(session, {
			workflowId: "workflow-context",
			rootTaskId: "task-root",
			planId: "plan-context",
			request: { text: "Persist context checkpoint", cwd: "C:/repo", attachments: [] },
		});
		const snapshotsBefore = session
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === WORKFLOW_SNAPSHOT_CUSTOM_TYPE);

		const checkpoint = runtime.checkpointForContextWindow();
		const persisted = session.getEntry(checkpoint.snapshotEntryId);

		expect(snapshotsBefore).toHaveLength(1);
		expect(checkpoint.workflowId).toBe("workflow-context");
		expect(persisted).toMatchObject({
			type: "custom",
			customType: WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
			data: checkpoint.snapshot,
		});
		if (persisted?.type !== "custom") throw new Error("Expected a persisted Workflow Snapshot");
		expect(persisted.data).not.toBe(checkpoint.snapshot);
	});

	it("captures the latest authoritative Plan state", () => {
		const session = SessionManager.inMemory("C:/repo");
		const runtime = PlanWorkflowRuntime.start(session, {
			workflowId: "workflow-latest",
			rootTaskId: "task-root",
			planId: "plan-latest",
			request: { text: "Capture latest state", cwd: "C:/repo", attachments: [] },
		});
		runtime.submit({
			goal: "Capture the submitted Plan",
			assumptions: [],
			steps: [
				{
					id: "step-1",
					title: "Checkpoint",
					description: "Persist the current state",
					dependsOn: [],
					fileIntents: [],
					verificationRequirementIds: ["verify-1"],
				},
			],
			risks: [],
			verificationRequirements: [
				{
					id: "verify-1",
					kind: "manual",
					description: "Checkpoint contains current state",
					required: true,
				},
			],
		});

		const checkpoint = runtime.checkpointForContextWindow();

		expect(checkpoint.snapshot.workflow).toMatchObject({
			id: "workflow-latest",
			status: "awaiting_approval",
			currentPlanId: "plan-latest",
		});
		expect(checkpoint.snapshot.plans).toEqual([
			expect.objectContaining({
				id: "plan-latest",
				status: "awaiting_approval",
				goal: "Capture the submitted Plan",
			}),
		]);
	});
});
