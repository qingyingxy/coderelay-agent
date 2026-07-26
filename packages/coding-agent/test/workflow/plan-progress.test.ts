import { describe, expect, it } from "vitest";
import type { Plan, Task } from "../../src/core/workflow/index.ts";
import { derivePlanProgress, WORKFLOW_SCHEMA_VERSION } from "../../src/core/workflow/index.ts";
import { NOW, ZERO_USAGE } from "./fixtures.ts";

function plan(): Plan {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: "plan-1",
		workflowId: "workflow-1",
		version: 1,
		status: "approved",
		goal: "Track Plan progress",
		assumptions: [],
		steps: ["one", "two", "three"].map((id) => ({
			id,
			title: id,
			description: id,
			dependsOn: [],
			fileIntents: [],
			verificationRequirementIds: [],
		})),
		risks: [],
		verificationRequirements: [
			{
				id: "manual",
				kind: "manual",
				description: "Verify completion",
				required: true,
			},
		],
		decisionHistory: [{ action: "approved", comment: "Approved", decidedAt: NOW }],
	};
}

function task(stepId: string, status: Task["status"]): Task {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: `task-${stepId}`,
		workflowId: "workflow-1",
		sourcePlanId: "plan-1",
		sourcePlanStepId: stepId,
		kind: "agent",
		accessMode: "writer",
		title: stepId,
		description: stepId,
		status,
		dependencyIds: [],
		budget: {},
		usage: ZERO_USAGE,
		attemptIds: [],
		verificationRequirements: [],
	};
}

describe("Plan progress", () => {
	it("derives progress only from linked Task states", () => {
		expect(derivePlanProgress(plan(), [task("one", "succeeded"), task("two", "running")])).toEqual({
			planId: "plan-1",
			totalSteps: 3,
			pendingSteps: 1,
			runningSteps: 1,
			succeededSteps: 1,
			failedSteps: 0,
			cancelledSteps: 0,
			percentComplete: 33,
		});
	});
});
