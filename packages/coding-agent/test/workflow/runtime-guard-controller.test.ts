import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { BudgetLimit, PlanContent } from "../../src/core/workflow/index.ts";
import {
	RuntimePolicyError,
	SessionWorkflowEventLog,
	WorkflowController,
	WorkflowStore,
} from "../../src/core/workflow/index.ts";
import { NOW, ZERO_USAGE } from "./fixtures.ts";

function planContent(): PlanContent {
	return {
		goal: "Run guarded Tasks",
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

function createController(): { controller: WorkflowController; store: WorkflowStore } {
	let sequence = 0;
	const store = new WorkflowStore();
	const controller = new WorkflowController(new SessionWorkflowEventLog(SessionManager.inMemory()), store, {
		createId: (kind) => `${kind}-${++sequence}`,
		now: () => NOW,
	});
	return { controller, store };
}

function startPlan(controller: WorkflowController, budget: BudgetLimit = {}): void {
	controller.startPlan({
		commandId: "start",
		workflowId: "workflow-plan",
		rootTaskId: "root",
		planId: "plan",
		request: {
			text: "Run guarded Tasks",
			cwd: "C:/repo",
			attachments: [],
		},
		budget,
	});
	controller.submitPlanForApproval({
		commandId: "submit",
		workflowId: "workflow-plan",
		planId: "plan",
		content: planContent(),
		plannerReadOnly: true,
	});
	controller.approvePlan({
		commandId: "approve",
		workflowId: "workflow-plan",
		planId: "plan",
		comment: "Approved",
	});
	controller.refreshTaskReadiness({
		commandId: "refresh",
		workflowId: "workflow-plan",
	});
}

function taskId(store: WorkflowStore, stepId: string): string {
	const task = store.listTasks("workflow-plan").find(({ sourcePlanStepId }) => sourcePlanStepId === stepId);
	if (!task) {
		throw new Error(`Missing Task for ${stepId}`);
	}
	return task.id;
}

describe("WorkflowController runtime guardrails", () => {
	it("records write ownership and rejects execution after the retry budget is exhausted", () => {
		const { controller, store } = createController();
		controller.startDirect({
			commandId: "start",
			workflowId: "workflow-direct",
			rootTaskId: "root",
			request: {
				text: "Modify a file",
				cwd: "C:/repo",
				attachments: [],
			},
			budget: { maxRetries: 0 },
		});
		controller.markTaskReady({
			commandId: "ready",
			workflowId: "workflow-direct",
			taskId: "root",
		});
		controller.prepareMainAgentAttempt({
			commandId: "prepare-1",
			workflowId: "workflow-direct",
			taskId: "root",
			attemptId: "attempt-1",
			agentId: "main-agent",
			writerLeaseId: "lease-1",
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "attempt-started",
			workflowId: "workflow-direct",
			taskId: "root",
			attemptId: "attempt-1",
		});
		controller.recordTaskModification({
			commandId: "modified",
			workflowId: "workflow-direct",
			taskId: "root",
			modification: {
				path: "src/index.ts",
				operation: "edit",
				attemptId: "attempt-1",
				agentId: "main-agent",
				toolCallId: "tool-1",
			},
		});
		controller.handleRuntimeEvent({
			type: "attempt_failed",
			commandId: "failed",
			workflowId: "workflow-direct",
			taskId: "root",
			attemptId: "attempt-1",
			usage: ZERO_USAGE,
			willRetry: true,
			failure: {
				code: "temporary",
				message: "Temporary failure",
			},
		});

		expect(store.getTask("root")?.modifications).toEqual([
			expect.objectContaining({
				workflowId: "workflow-direct",
				taskId: "root",
				attemptId: "attempt-1",
				agentId: "main-agent",
				path: "src/index.ts",
			}),
		]);
		expect(() =>
			controller.prepareMainAgentAttempt({
				commandId: "prepare-2",
				workflowId: "workflow-direct",
				taskId: "root",
				attemptId: "attempt-2",
				agentId: "main-agent",
				writerLeaseId: "lease-1",
			}),
		).toThrow(RuntimePolicyError);
	});

	it("rejects new Agents above Workflow concurrency and depth limits", () => {
		const concurrencyHarness = createController();
		startPlan(concurrencyHarness.controller, {
			maxConcurrentAgents: 1,
			maxAgentDepth: 1,
		});
		const inspectA = taskId(concurrencyHarness.store, "inspect-a");
		const inspectB = taskId(concurrencyHarness.store, "inspect-b");
		concurrencyHarness.controller.prepareTaskAttempt({
			commandId: "prepare-a",
			workflowId: "workflow-plan",
			taskId: inspectA,
			attemptId: "attempt-a",
			assignment: {
				executorKind: "subagent",
				agentId: "explorer-a",
				agentDepth: 1,
			},
		});

		expect(() =>
			concurrencyHarness.controller.prepareTaskAttempt({
				commandId: "prepare-b",
				workflowId: "workflow-plan",
				taskId: inspectB,
				attemptId: "attempt-b",
				assignment: {
					executorKind: "subagent",
					agentId: "explorer-b",
					agentDepth: 1,
				},
			}),
		).toThrow(RuntimePolicyError);

		const depthHarness = createController();
		startPlan(depthHarness.controller, {
			maxConcurrentAgents: 2,
			maxAgentDepth: 0,
		});
		expect(() =>
			depthHarness.controller.prepareTaskAttempt({
				commandId: "prepare-too-deep",
				workflowId: "workflow-plan",
				taskId: taskId(depthHarness.store, "inspect-a"),
				attemptId: "attempt-too-deep",
				assignment: {
					executorKind: "subagent",
					agentId: "explorer-child",
					agentDepth: 1,
				},
			}),
		).toThrow(RuntimePolicyError);
	});

	it("cancels every non-terminal Task and active Attempt in a Plan Workflow", () => {
		const { controller, store } = createController();
		startPlan(controller);
		const inspectA = taskId(store, "inspect-a");
		controller.prepareTaskAttempt({
			commandId: "prepare-a",
			workflowId: "workflow-plan",
			taskId: inspectA,
			attemptId: "attempt-a",
			assignment: {
				executorKind: "main_agent",
				agentId: "main-agent",
			},
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "start-a",
			workflowId: "workflow-plan",
			taskId: inspectA,
			attemptId: "attempt-a",
		});
		controller.requestCancellation({
			commandId: "cancel-requested",
			workflowId: "workflow-plan",
			reason: "User cancelled",
		});
		controller.finishCancellation({
			commandId: "cancel-finished",
			workflowId: "workflow-plan",
			taskId: "root",
			reason: "User cancelled",
			usage: ZERO_USAGE,
			durationMs: 0,
			runtimeResourcesStopped: true,
			writerLeaseReleased: true,
		});

		expect(store.getAttempt("attempt-a")?.status).toBe("cancelled");
		expect(store.listTasks("workflow-plan").every(({ status }) => status === "cancelled")).toBe(true);
		expect(store.getWorkflow("workflow-plan")?.status).toBe("cancelled");
	});
});
