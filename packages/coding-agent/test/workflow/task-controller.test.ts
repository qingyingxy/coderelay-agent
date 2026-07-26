import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { PlanContent } from "../../src/core/workflow/index.ts";
import {
	SessionWorkflowEventLog,
	WorkflowController,
	WorkflowControllerError,
	WorkflowStore,
} from "../../src/core/workflow/index.ts";
import { NOW, ZERO_USAGE } from "./fixtures.ts";

function planContent(): PlanContent {
	return {
		goal: "Schedule a Task graph",
		assumptions: [],
		steps: [
			{
				id: "inspect-a",
				title: "Inspect A",
				description: "Inspect the first area",
				dependsOn: [],
				fileIntents: [{ path: "src/a.ts", action: "inspect", reason: "Understand A" }],
				verificationRequirementIds: ["manual"],
			},
			{
				id: "inspect-b",
				title: "Inspect B",
				description: "Inspect the second area",
				dependsOn: [],
				fileIntents: [{ path: "src/b.ts", action: "inspect", reason: "Understand B" }],
				verificationRequirementIds: ["manual"],
			},
			{
				id: "implement",
				title: "Implement",
				description: "Apply the change",
				dependsOn: ["inspect-a"],
				fileIntents: [{ path: "src/a.ts", action: "modify", reason: "Apply the change" }],
				verificationRequirementIds: ["manual"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "manual",
				kind: "manual",
				description: "Review the result",
				required: true,
			},
		],
	};
}

function harness(): { controller: WorkflowController; store: WorkflowStore } {
	let sequence = 0;
	const store = new WorkflowStore();
	const controller = new WorkflowController(new SessionWorkflowEventLog(SessionManager.inMemory()), store, {
		createId: (kind) => `${kind}-${++sequence}`,
		now: () => NOW,
	});
	controller.startPlan({
		commandId: "start",
		workflowId: "workflow-task",
		rootTaskId: "root",
		planId: "plan",
		request: {
			text: "Schedule this work",
			cwd: "C:/repo",
			attachments: [],
		},
	});
	controller.submitPlanForApproval({
		commandId: "submit",
		workflowId: "workflow-task",
		planId: "plan",
		content: planContent(),
		plannerReadOnly: true,
	});
	controller.approvePlan({
		commandId: "approve",
		workflowId: "workflow-task",
		planId: "plan",
		comment: "Approved",
	});
	return { controller, store };
}

function taskId(store: WorkflowStore, stepId: string): string {
	const task = store.listTasks("workflow-task").find(({ sourcePlanStepId }) => sourcePlanStepId === stepId);
	if (!task) {
		throw new Error(`Missing Task for ${stepId}`);
	}
	return task.id;
}

describe("Task WorkflowController", () => {
	it("derives Ready state, supports blocking and retry, and creates executor-specific Attempts", () => {
		const { controller, store } = harness();
		const inspectA = taskId(store, "inspect-a");
		const inspectB = taskId(store, "inspect-b");
		const implement = taskId(store, "implement");

		controller.refreshTaskReadiness({
			commandId: "refresh",
			workflowId: "workflow-task",
		});
		expect(store.getTask(inspectA)?.status).toBe("ready");
		expect(store.getTask(inspectB)?.status).toBe("ready");
		expect(store.getTask(implement)?.status).toBe("pending");

		controller.blockTask({
			commandId: "block",
			workflowId: "workflow-task",
			taskId: inspectA,
			reason: {
				code: "external_resource",
				message: "Waiting for a local fixture",
				since: NOW,
				resumeStatus: "ready",
			},
		});
		controller.retryTask({
			commandId: "retry",
			workflowId: "workflow-task",
			taskId: inspectA,
		});
		controller.prepareTaskAttempt({
			commandId: "attempt-1",
			workflowId: "workflow-task",
			taskId: inspectA,
			attemptId: "attempt-a-1",
			assignment: {
				executorKind: "subagent",
				agentId: "explorer-1",
			},
		});

		expect(store.getTask(inspectA)).toMatchObject({
			status: "running",
			assignment: { executorKind: "subagent", agentId: "explorer-1" },
		});
		expect(store.getAttempt("attempt-a-1")).toMatchObject({
			number: 1,
			executorKind: "subagent",
			agentId: "explorer-1",
		});
	});

	it("creates a distinct Attempt for an allowed retry", () => {
		const { controller, store } = harness();
		const inspectA = taskId(store, "inspect-a");
		const implement = taskId(store, "implement");
		controller.refreshTaskReadiness({ commandId: "refresh", workflowId: "workflow-task" });
		controller.prepareTaskAttempt({
			commandId: "prepare-1",
			workflowId: "workflow-task",
			taskId: inspectA,
			attemptId: "attempt-1",
			assignment: { executorKind: "main_agent", agentId: "main" },
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "start-1",
			workflowId: "workflow-task",
			taskId: inspectA,
			attemptId: "attempt-1",
		});
		controller.handleRuntimeEvent({
			type: "attempt_failed",
			commandId: "fail-1",
			workflowId: "workflow-task",
			taskId: inspectA,
			attemptId: "attempt-1",
			usage: ZERO_USAGE,
			willRetry: true,
			failure: {
				code: "temporary",
				message: "Temporary failure",
			},
		});
		controller.prepareTaskAttempt({
			commandId: "prepare-2",
			workflowId: "workflow-task",
			taskId: inspectA,
			attemptId: "attempt-2",
			assignment: { executorKind: "main_agent", agentId: "main" },
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "start-2",
			workflowId: "workflow-task",
			taskId: inspectA,
			attemptId: "attempt-2",
		});
		controller.handleRuntimeEvent({
			type: "attempt_succeeded",
			commandId: "succeed-2",
			workflowId: "workflow-task",
			taskId: inspectA,
			attemptId: "attempt-2",
			verificationId: "verification-a",
			requirementId: "manual",
			usage: ZERO_USAGE,
			summary: "Inspected A",
		});
		controller.completeTask({
			commandId: "complete-a",
			workflowId: "workflow-task",
			taskId: inspectA,
			verificationId: "verification-a",
			summary: "Inspected A",
			changedFiles: [],
		});
		controller.refreshTaskReadiness({ commandId: "refresh-2", workflowId: "workflow-task" });

		expect(store.listAttempts(inspectA).map(({ id, number }) => ({ id, number }))).toEqual([
			{ id: "attempt-1", number: 1 },
			{ id: "attempt-2", number: 2 },
		]);
		expect(store.getAttempt("attempt-1")?.status).toBe("failed");
		expect(store.getAttempt("attempt-2")?.status).toBe("succeeded");
		expect(store.getTask(inspectA)?.status).toBe("succeeded");
		expect(store.getTask(implement)?.status).toBe("ready");
	});

	it("cancels an unstarted Task and blocks its dependents", () => {
		const { controller, store } = harness();
		const inspectA = taskId(store, "inspect-a");
		const implement = taskId(store, "implement");
		controller.refreshTaskReadiness({ commandId: "refresh-1", workflowId: "workflow-task" });
		controller.cancelTask({
			commandId: "cancel",
			workflowId: "workflow-task",
			taskId: inspectA,
			reason: "No longer required",
		});
		controller.refreshTaskReadiness({ commandId: "refresh-2", workflowId: "workflow-task" });

		expect(store.getTask(inspectA)?.status).toBe("cancelled");
		expect(store.getTask(implement)).toMatchObject({
			status: "blocked",
			blockedReason: {
				code: "dependency_failed",
			},
		});
		expect(() =>
			controller.retryTask({
				commandId: "retry-blocked",
				workflowId: "workflow-task",
				taskId: implement,
			}),
		).toThrow(WorkflowControllerError);
	});
});
