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

	it("records a successful faux-provider run as an Attempt awaiting verification", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage("Implemented")]);

		await harness.session.prompt("Implement a CLI change");

		const { store, workflowId } = replayWorkflow(harness);
		const workflow = store.getWorkflow(workflowId);
		const task = workflow?.rootTaskId ? store.getTask(workflow.rootTaskId) : undefined;
		const attempt = task?.currentAttemptId ? store.getAttempt(task.currentAttemptId) : undefined;
		expect(workflow?.status).toBe("executing");
		expect(task?.status).toBe("verifying");
		expect(attempt).toMatchObject({
			number: 1,
			status: "succeeded",
			usage: {
				turns: 1,
			},
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
		expect(task?.status).toBe("verifying");
		expect(workflow?.status).toBe("executing");
	});
});
