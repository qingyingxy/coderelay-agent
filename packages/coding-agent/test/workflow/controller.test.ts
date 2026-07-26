import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	SessionWorkflowEventLog,
	WorkflowController,
	WorkflowControllerError,
	WorkflowStore,
} from "../../src/core/workflow/index.ts";
import { NOW, ZERO_USAGE } from "./fixtures.ts";

const WORKFLOW_ID = "workflow-1";
const TASK_ID = "task-1";
const ATTEMPT_ID = "attempt-1";
const VERIFICATION_ID = "verification-1";
const CANCEL_USAGE = {
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 2,
	cacheWriteTokens: 1,
	cost: 0.01,
	turns: 1,
	durationMs: 25,
};
const CANCEL_WORKFLOW_USAGE = {
	...CANCEL_USAGE,
	inputTokens: 30,
	outputTokens: 15,
	cost: 0.03,
	turns: 2,
	durationMs: 50,
};

function createHarness(session = SessionManager.inMemory()): {
	readonly controller: WorkflowController;
	readonly eventLog: SessionWorkflowEventLog;
	readonly store: WorkflowStore;
} {
	let nextId = 0;
	const eventLog = new SessionWorkflowEventLog(session);
	const store = new WorkflowStore();
	const controller = new WorkflowController(eventLog, store, {
		createId: (kind) => `${kind}-${++nextId}`,
		now: () => NOW,
	});
	return { controller, eventLog, store };
}

function startDirect(controller: WorkflowController, commandId = "start-command"): void {
	controller.startDirect({
		commandId,
		workflowId: WORKFLOW_ID,
		rootTaskId: TASK_ID,
		request: {
			text: "Implement a small change",
			cwd: "C:/repo",
			attachments: [],
		},
	});
}

function startAttempt(controller: WorkflowController): void {
	startDirect(controller);
	controller.markTaskReady({
		commandId: "ready-command",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
	});
	controller.prepareMainAgentAttempt({
		commandId: "prepare-command",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		writerLeaseId: "writer-lease",
	});
	controller.handleRuntimeEvent({
		type: "attempt_started",
		commandId: "attempt-started-command",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
	});
}

function finishAttempt(controller: WorkflowController): void {
	controller.handleRuntimeEvent({
		type: "attempt_succeeded",
		commandId: "attempt-succeeded-command",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		verificationId: VERIFICATION_ID,
		usage: ZERO_USAGE,
		summary: "AgentSession completed",
	});
}

describe("WorkflowController", () => {
	it("starts a Direct workflow through one persisted command", () => {
		const { controller, eventLog, store } = createHarness();

		const result = controller.startDirect({
			commandId: "start-command",
			workflowId: WORKFLOW_ID,
			rootTaskId: TASK_ID,
			request: {
				text: "Implement a small change",
				cwd: "C:/repo",
				requestedMode: "direct",
				attachments: [],
			},
		});

		expect(result).toMatchObject({
			applied: true,
			workflow: {
				id: WORKFLOW_ID,
				status: "executing",
				modeDecision: {
					mode: "direct",
					source: "user",
					reason: "User explicitly selected Direct mode",
					riskLevel: "low",
					decidedAt: NOW,
				},
			},
			rootTask: {
				id: TASK_ID,
				status: "pending",
			},
		});
		expect(eventLog.read()).toHaveLength(1);
		expect(store.getLastSequence(WORKFLOW_ID)).toBe(4);
	});

	it("does not override an explicit Plan mode request", () => {
		const { controller, eventLog } = createHarness();

		expect(() =>
			controller.startDirect({
				commandId: "start-command",
				workflowId: WORKFLOW_ID,
				rootTaskId: TASK_ID,
				request: {
					text: "Plan a risky change",
					cwd: "C:/repo",
					requestedMode: "plan",
					attachments: [],
				},
			}),
		).toThrow(WorkflowControllerError);
		expect(eventLog.read()).toHaveLength(0);
	});

	it("returns the original result for a duplicate command", () => {
		const { controller, eventLog } = createHarness();
		startDirect(controller);

		const duplicate = controller.startDirect({
			commandId: "start-command",
			workflowId: WORKFLOW_ID,
			rootTaskId: TASK_ID,
			request: {
				text: "A different payload is ignored",
				cwd: "C:/other",
				attachments: [],
			},
		});

		expect(duplicate.applied).toBe(false);
		expect(duplicate.workflow.request.text).toBe("Implement a small change");
		expect(eventLog.read()).toHaveLength(1);
	});

	it("recovers the authoritative projection when the controller is recreated", () => {
		const session = SessionManager.inMemory();
		const first = createHarness(session);
		startDirect(first.controller);
		first.controller.markTaskReady({
			commandId: "ready-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
		});

		const recovered = createHarness(session);

		expect(recovered.controller.getWorkflow(WORKFLOW_ID)?.status).toBe("executing");
		expect(recovered.controller.getRootTask(WORKFLOW_ID)?.status).toBe("ready");
		expect(recovered.store.getLastSequence(WORKFLOW_ID)).toBe(5);
	});

	it("records the Main Agent attempt lifecycle", () => {
		const { controller, store } = createHarness();

		startAttempt(controller);

		expect(store.getTask(TASK_ID)).toMatchObject({
			status: "running",
			currentAttemptId: ATTEMPT_ID,
			assignment: {
				executorKind: "main_agent",
			},
		});
		expect(store.getAttempt(ATTEMPT_ID)).toMatchObject({
			status: "running",
			startedAt: NOW,
		});
	});

	it("returns the Task to ready when Pi will retry", () => {
		const { controller, store } = createHarness();
		startAttempt(controller);

		controller.handleRuntimeEvent({
			type: "attempt_failed",
			commandId: "attempt-failed-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: ATTEMPT_ID,
			usage: ZERO_USAGE,
			willRetry: true,
			failure: {
				code: "provider.overloaded",
				message: "Provider overloaded",
			},
		});

		expect(store.getAttempt(ATTEMPT_ID)).toMatchObject({
			status: "failed",
			failure: {
				retryable: true,
			},
		});
		expect(store.getTask(TASK_ID)?.status).toBe("ready");
		expect(store.getWorkflow(WORKFLOW_ID)?.status).toBe("executing");
	});

	it("rejects invalid runtime usage before appending an Event Batch", () => {
		const { controller, eventLog, store } = createHarness();
		startAttempt(controller);
		const batchCount = eventLog.read().length;

		expect(() =>
			controller.handleRuntimeEvent({
				type: "attempt_succeeded",
				commandId: "attempt-succeeded-command",
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
				verificationId: VERIFICATION_ID,
				usage: {
					...ZERO_USAGE,
					cost: -1,
				},
				summary: "Invalid result",
			}),
		).toThrow(WorkflowControllerError);

		expect(eventLog.read()).toHaveLength(batchCount);
		expect(store.getAttempt(ATTEMPT_ID)?.status).toBe("running");
		expect(store.getTask(TASK_ID)?.status).toBe("running");
	});

	it("fails the Task and Workflow when Pi will not retry", () => {
		const { controller, store } = createHarness();
		startAttempt(controller);

		controller.handleRuntimeEvent({
			type: "attempt_failed",
			commandId: "attempt-failed-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: ATTEMPT_ID,
			usage: ZERO_USAGE,
			willRetry: false,
			failure: {
				code: "agent.error",
				message: "Agent failed",
			},
		});

		expect(store.getAttempt(ATTEMPT_ID)?.status).toBe("failed");
		expect(store.getTask(TASK_ID)?.status).toBe("failed");
		expect(store.getWorkflow(WORKFLOW_ID)).toMatchObject({
			status: "failed",
			result: {
				status: "failed",
				reason: "Agent failed",
			},
		});
	});

	it("supports an explicit terminal failure after runtime execution has ended", () => {
		const { controller, store } = createHarness();
		startAttempt(controller);
		finishAttempt(controller);

		const result = controller.fail({
			commandId: "fail-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			reason: "Final Agent message is missing",
			usage: ZERO_USAGE,
			durationMs: 10,
			runtimeResourcesStopped: true,
		});

		expect(store.getTask(TASK_ID)?.status).toBe("failed");
		expect(result.workflow).toMatchObject({
			status: "failed",
			result: {
				reason: "Final Agent message is missing",
			},
		});
	});

	it("completes only after the attempt and verification gates", () => {
		const { controller, store } = createHarness();
		startAttempt(controller);
		finishAttempt(controller);

		const result = controller.complete({
			commandId: "complete-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			verificationId: VERIFICATION_ID,
			summary: "Change implemented",
			changedFiles: ["src/example.ts"],
			usage: ZERO_USAGE,
			durationMs: 10,
		});

		expect(store.getVerification(VERIFICATION_ID)?.status).toBe("passed");
		expect(store.getTask(TASK_ID)?.status).toBe("succeeded");
		expect(result.workflow).toMatchObject({
			status: "completed",
			result: {
				changedFiles: ["src/example.ts"],
				verificationIds: [VERIFICATION_ID],
			},
		});
	});

	it("treats a repeated completion command as the original persisted result", () => {
		const { controller, eventLog, store } = createHarness();
		startAttempt(controller);
		finishAttempt(controller);
		const command = {
			commandId: "complete-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			verificationId: VERIFICATION_ID,
			summary: "Change implemented",
			changedFiles: ["src/example.ts"],
			usage: ZERO_USAGE,
			durationMs: 10,
		} as const;

		const first = controller.complete(command);
		const batchCount = eventLog.read().length;
		const duplicate = controller.complete({
			...command,
			summary: "A retried command must not replace the original result",
			changedFiles: ["src/other.ts"],
		});

		expect(first.applied).toBe(true);
		expect(duplicate).toMatchObject({
			applied: false,
			batchId: first.batchId,
			workflow: {
				status: "completed",
				result: {
					summary: "Change implemented",
					changedFiles: ["src/example.ts"],
				},
			},
		});
		expect(eventLog.read()).toHaveLength(batchCount);
		expect(store.getWorkflow(WORKFLOW_ID)?.revision).toBe(first.workflow.revision);
	});

	it("cancels in two phases and treats repeated cancellation as a no-op", () => {
		const { controller, eventLog, store } = createHarness();
		startDirect(controller);
		controller.markTaskReady({
			commandId: "ready-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
		});
		controller.prepareMainAgentAttempt({
			commandId: "prepare-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: ATTEMPT_ID,
			writerLeaseId: "writer-lease",
		});

		controller.requestCancellation({
			commandId: "cancel-request-command",
			workflowId: WORKFLOW_ID,
			reason: "User cancelled",
		});
		const repeatedRequest = controller.requestCancellation({
			commandId: "cancel-request-again-command",
			workflowId: WORKFLOW_ID,
			reason: "User cancelled again",
		});
		expect(repeatedRequest).toMatchObject({
			applied: false,
			workflow: {
				status: "cancelling",
			},
		});

		controller.finishCancellation({
			commandId: "cancel-finish-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			reason: "User cancelled",
			usage: CANCEL_WORKFLOW_USAGE,
			attemptUsage: CANCEL_USAGE,
			durationMs: CANCEL_WORKFLOW_USAGE.durationMs,
			runtimeResourcesStopped: true,
			writerLeaseReleased: true,
		});
		const batchCount = eventLog.read().length;
		const repeatedFinish = controller.finishCancellation({
			commandId: "cancel-finish-again-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			reason: "User cancelled again",
			usage: ZERO_USAGE,
			durationMs: 5,
			runtimeResourcesStopped: true,
			writerLeaseReleased: true,
		});

		expect(store.getAttempt(ATTEMPT_ID)).toMatchObject({
			status: "cancelled",
			usage: CANCEL_USAGE,
		});
		expect(store.getTask(TASK_ID)?.status).toBe("cancelled");
		expect(store.getWorkflow(WORKFLOW_ID)?.result?.usage).toEqual(CANCEL_WORKFLOW_USAGE);
		expect(repeatedFinish).toMatchObject({
			applied: false,
			workflow: {
				status: "cancelled",
			},
		});
		expect(eventLog.read()).toHaveLength(batchCount);
	});

	it("does not start a new Attempt after cancellation begins", () => {
		const { controller, eventLog, store } = createHarness();
		startDirect(controller);
		controller.markTaskReady({
			commandId: "ready-command",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
		});
		controller.requestCancellation({
			commandId: "cancel-request-command",
			workflowId: WORKFLOW_ID,
			reason: "User cancelled",
		});
		const batchCount = eventLog.read().length;

		expect(() =>
			controller.prepareMainAgentAttempt({
				commandId: "prepare-command",
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
			}),
		).toThrow(WorkflowControllerError);

		expect(eventLog.read()).toHaveLength(batchCount);
		expect(store.getAttempt(ATTEMPT_ID)).toBeUndefined();
		expect(store.getTask(TASK_ID)?.status).toBe("ready");
	});

	it("does not append events when a command guard fails", () => {
		const { controller, eventLog, store } = createHarness();
		startDirect(controller);

		expect(() =>
			controller.prepareMainAgentAttempt({
				commandId: "prepare-command",
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
			}),
		).toThrow(WorkflowControllerError);

		expect(eventLog.read()).toHaveLength(1);
		expect(store.getTask(TASK_ID)?.status).toBe("pending");
		expect(store.getAttempt(ATTEMPT_ID)).toBeUndefined();
	});
});
