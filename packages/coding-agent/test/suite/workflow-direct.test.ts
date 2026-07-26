import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionWorkflowEventLog, WorkflowStore } from "../../src/core/workflow/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

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
			statusLine: "direct | completed | 1 task | 0 files | tests: not configured",
			task: {
				status: "succeeded",
			},
			changedFiles: [],
		});
	});

	it("reports files changed by successful built-in write and edit tools", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", {
					path: "src/demo.ts",
					content: "export const value = 1;\n",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: "src/demo.ts",
					edits: [{ oldText: "value = 1", newText: "value = 2" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Implemented"),
		]);

		await harness.session.prompt("Create and update a TypeScript file");

		expect(readFileSync(join(harness.tempDir, "src/demo.ts"), "utf8")).toBe("export const value = 2;\n");
		expect(harness.session.getLatestWorkflowReport()).toMatchObject({
			status: "completed",
			statusLine: "direct | completed | 1 task | 1 file | tests: not configured",
			changedFiles: ["src/demo.ts"],
		});
	});

	it("creates a new Workflow after the previous request reaches a terminal state", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage("First complete"), fauxAssistantMessage("Second complete")]);

		await harness.session.prompt("First request");
		const firstReport = harness.session.getLatestWorkflowReport();
		await harness.session.prompt("Second request");
		const secondReport = harness.session.getLatestWorkflowReport();

		const batches = new SessionWorkflowEventLog(harness.sessionManager).read();
		const workflowIds = [...new Set(batches.map(({ batch }) => batch.workflowId))];
		const store = new WorkflowStore();
		store.replay(batches);

		expect(firstReport?.status).toBe("completed");
		expect(secondReport?.status).toBe("completed");
		expect(secondReport?.workflowId).not.toBe(firstReport?.workflowId);
		expect(workflowIds).toEqual([firstReport?.workflowId, secondReport?.workflowId]);
		expect(workflowIds.map((workflowId) => store.getWorkflow(workflowId)?.status)).toEqual([
			"completed",
			"completed",
		]);
	});

	it("shows the latest Workflow without calling the provider or creating another Workflow", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage("Implemented")]);

		await harness.session.prompt("Implement a CLI change");
		const callCount = harness.faux.state.callCount;
		const workflowBatchCount = new SessionWorkflowEventLog(harness.sessionManager).read().length;

		await harness.session.prompt("/workflow");

		const message = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.slice()
			.reverse()
			.find((candidate) => candidate.role === "custom" && candidate.customType === "workflow");
		expect(getMessageText(message)).toContain("direct | completed | 1 task | 0 files | tests: not configured");
		expect(harness.faux.state.callCount).toBe(callCount);
		expect(new SessionWorkflowEventLog(harness.sessionManager).read()).toHaveLength(workflowBatchCount);
		expect(harness.session.messages.some((candidate) => candidate.role === "custom")).toBe(false);
	});

	it("reports when no Workflow exists without calling the provider", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();

		await harness.session.prompt("/workflow");

		const message = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.slice()
			.reverse()
			.find((candidate) => candidate.role === "custom" && candidate.customType === "workflow");
		expect(getMessageText(message)).toBe("No Workflow has been created in this session.");
		expect(harness.faux.state.callCount).toBe(0);
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

		await harness.session.prompt("/workflow", { streamingBehavior: "steer" });
		const statusMessage = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.slice()
			.reverse()
			.find((candidate) => candidate.role === "custom" && candidate.customType === "workflow");
		expect(getMessageText(statusMessage)).toContain("direct | executing | task: running | attempt: 1");
		expect(harness.session.pendingMessageCount).toBe(0);

		await harness.session.prompt("/workflow-cancel", { streamingBehavior: "steer" });
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
				reason: "User cancelled the workflow",
			},
		});
		expect(harness.session.getLatestWorkflowReport()).toMatchObject({
			status: "cancelled",
			failureReason: "User cancelled the workflow",
		});
		expect(await harness.session.cancelWorkflow()).toBe(false);
	});
});
