import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionWorkflowEventLog, WorkflowStore } from "../../src/core/workflow/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function replayWorkflow(harness: Harness): {
	readonly store: WorkflowStore;
	readonly workflowId: string;
} {
	const batches = new SessionWorkflowEventLog(harness.sessionManager).read();
	const workflowId = batches[0]?.batch.workflowId;
	if (!workflowId) {
		throw new Error("Expected a Direct Workflow");
	}
	const store = new WorkflowStore();
	store.replay(batches);
	return { store, workflowId };
}

describe("Direct Workflow AgentSession integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("completes a successful faux-provider run after basic verification", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage("Implemented")]);

		await harness.session.prompt("Implement a CLI change");

		const { store, workflowId } = replayWorkflow(harness);
		const workflow = store.getWorkflow(workflowId);
		const task = workflow?.rootTaskId ? store.getTask(workflow.rootTaskId) : undefined;
		const attempt = task?.currentAttemptId ? store.getAttempt(task.currentAttemptId) : undefined;
		expect(workflow?.status).toBe("completed");
		expect(task?.status).toBe("succeeded");
		expect(attempt).toMatchObject({
			number: 1,
			status: "succeeded",
			usage: {
				turns: 1,
			},
		});
		const verificationId = task?.result?.verificationIds[0];
		expect(verificationId).toBeDefined();
		expect(verificationId ? store.getVerification(verificationId) : undefined).toMatchObject({
			status: "passed",
			evidenceRefs: ["review:not-configured", "test:not-configured", "build:not-configured"],
		});
		expect(harness.session.getLatestWorkflowReport()).toMatchObject({
			status: "completed",
			task: {
				status: "succeeded",
			},
			changedFiles: [],
		});
	});

	it("creates a second Attempt when AgentSession automatically retries", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					maxRetries: 2,
					baseDelayMs: 1,
				},
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
			fauxAssistantMessage("Recovered"),
		]);

		await harness.session.prompt("Implement a CLI change");

		const { store, workflowId } = replayWorkflow(harness);
		const workflow = store.getWorkflow(workflowId);
		const task = workflow?.rootTaskId ? store.getTask(workflow.rootTaskId) : undefined;
		const attempts = task ? store.listAttempts(task.id) : [];
		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toMatchObject({
			number: 1,
			status: "failed",
			failure: {
				retryable: true,
			},
		});
		expect(attempts[1]).toMatchObject({
			number: 2,
			status: "succeeded",
		});
		expect(task?.status).toBe("succeeded");
		expect(workflow?.status).toBe("completed");
	});

	it("reports the final AgentSession failure reason", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: false,
				},
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "invalid_api_key",
			}),
		]);

		await harness.session.prompt("Implement a CLI change");

		expect(harness.session.getLatestWorkflowReport()).toMatchObject({
			status: "failed",
			failureReason: "invalid_api_key",
			task: {
				status: "failed",
			},
			attempts: [
				{
					status: "failed",
					failure: {
						message: "invalid_api_key",
						retryable: false,
					},
				},
			],
		});
	});

	it("cancels an active AgentSession before persisting the terminal Workflow state", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("Implement a CLI change");
		await sawMessageUpdate;

		expect(await harness.session.cancelWorkflow("User cancelled")).toBe(true);
		await promptPromise;

		const { store, workflowId } = replayWorkflow(harness);
		const workflow = store.getWorkflow(workflowId);
		const task = workflow?.rootTaskId ? store.getTask(workflow.rootTaskId) : undefined;
		const attempt = task?.currentAttemptId ? store.getAttempt(task.currentAttemptId) : undefined;
		expect(attempt?.status).toBe("cancelled");
		expect(task?.status).toBe("cancelled");
		expect(workflow).toMatchObject({
			status: "cancelled",
			result: {
				reason: "User cancelled",
			},
		});
		expect(harness.session.getLatestWorkflowReport()).toMatchObject({
			status: "cancelled",
			failureReason: "User cancelled",
		});
		expect(await harness.session.cancelWorkflow()).toBe(false);
	});
});
