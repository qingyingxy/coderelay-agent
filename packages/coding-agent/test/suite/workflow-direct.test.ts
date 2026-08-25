import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EXECUTION_PROTOCOL_VERSION,
	SessionWorkflowEventLog,
	type WorkflowExecutionProtocol,
	WorkflowStore,
} from "../../src/core/workflow/index.ts";
import {
	type JobProcessFactory,
	JobRuntime,
	ModelGateway,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "../workflow/subagent-fixtures.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const MAIN_EXPLORER_PROTOCOL: WorkflowExecutionProtocol = {
	version: EXECUTION_PROTOCOL_VERSION,
	name: "main-explorer",
	requirements: [
		{
			id: "explorer-before-main",
			stage: "before_main",
			role: "explorer",
			required: true,
			minRuns: 1,
			maxRuns: 1,
			failurePolicy: "fail_workflow",
		},
	],
};

const MAIN_REVIEWER_PROTOCOL: WorkflowExecutionProtocol = {
	version: EXECUTION_PROTOCOL_VERSION,
	name: "main-reviewer",
	requirements: [
		{
			id: "reviewer-before-delivery",
			stage: "before_delivery",
			role: "reviewer",
			required: true,
			minRuns: 1,
			maxRuns: 1,
			failurePolicy: "fail_workflow",
		},
	],
};

const DIRECT_PLANNER_LITE_REVIEWER_PROTOCOL: WorkflowExecutionProtocol = {
	version: EXECUTION_PROTOCOL_VERSION,
	name: "direct-planner-lite-reviewer",
	requirements: [
		{
			id: "planner-lite-before-main",
			stage: "before_main",
			role: "planner",
			required: true,
			minRuns: 1,
			maxRuns: 2,
			failurePolicy: "retry_once",
		},
		{
			id: "reviewer-before-delivery",
			stage: "before_delivery",
			role: "reviewer",
			required: true,
			minRuns: 1,
			maxRuns: 2,
			failurePolicy: "retry_once",
		},
	],
};

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "faux",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function routingGateway(): ModelGateway {
	const models = [model("faux-fast"), model("faux-balanced"), model("faux-strong")];
	return new ModelGateway(
		{
			getModel: (provider, id) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
			hasConfiguredAuth: () => true,
		},
		{
			enabled: true,
			fastModel: "faux/faux-fast",
			balancedModel: "faux/faux-balanced",
			strongModel: "faux/faux-strong",
		},
	);
}

class SequencedVerificationFactory implements JobProcessFactory {
	readonly commands: string[] = [];
	readonly #exitCodes: readonly number[];

	constructor(exitCodes: readonly number[]) {
		this.#exitCodes = exitCodes;
	}

	start(input: Parameters<JobProcessFactory["start"]>[0]) {
		const index = this.commands.length;
		const exitCode = this.#exitCodes[index] ?? 0;
		this.commands.push(input.command);
		return {
			pid: 10_000 + index,
			wait: async () => {
				if (exitCode === 0) {
					input.onStdout(`verification ${index + 1} passed\n`);
				} else {
					input.onStderr(`verification ${index + 1} failed with assertion mismatch\n`);
				}
				return { exitCode };
			},
			terminate: async () => undefined,
		};
	}
}

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
		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: { id: workflowId, status: "completed" },
			rootTask: { id: task?.id, status: "succeeded" },
			availableActions: ["resume"],
		});
		expect(harness.session.getWorkflowStatusLine()).toContain(
			`direct | completed | root: ${task?.id} | 1 task | 0 files`,
		);
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
			changedFiles: ["src/demo.ts"],
		});
		expect(harness.session.getWorkflowStatusLine()).toContain("1 task | 1 file | tests: not configured");
	});

	it("enforces Explorer before main even when the main model does not delegate", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subagentRuntime = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const harness = await createHarness({ subagentRuntime });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct", false, MAIN_EXPLORER_PROTOCOL);
		harness.setResponses([fauxAssistantMessage("Implemented without calling a Subagent tool")]);

		const prompt = harness.session.prompt("Implement a CLI change");
		await vi.waitFor(() => expect(factory.sessions).toHaveLength(1));
		expect(factory.sessions[0]?.config.profile.name).toBe("explorer");
		factory.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Found the implementation boundary",
				evidence: [{ path: "src/index.ts", line: 12, note: "Entry point" }],
			}),
		);
		await prompt;

		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: { status: "completed" },
			agents: [expect.objectContaining({ profileName: "explorer", handoffId: expect.any(String) })],
			executionProtocol: {
				satisfied: true,
				requirements: [
					expect.objectContaining({
						id: "explorer-before-main",
						succeededRuns: 1,
						satisfied: true,
					}),
				],
			},
		});
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "workflow-protocol-handoff",
			),
		).toBe(true);
	});

	it("cancels a required Explorer without starting the main Agent", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subagentRuntime = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const harness = await createHarness({ subagentRuntime });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct", false, MAIN_EXPLORER_PROTOCOL);
		harness.setResponses([fauxAssistantMessage("Main must not run")]);

		const prompt = harness.session.prompt("Implement a CLI change");
		await vi.waitFor(() => expect(factory.sessions).toHaveLength(1));
		expect(await harness.session.cancelWorkflow("Cancelled during Explorer")).toBe(true);
		await expect(prompt).rejects.toThrow();

		expect(factory.sessions[0]?.abortCalls).toBe(1);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: {
				status: "cancelled",
				result: { reason: "Cancelled during Explorer" },
			},
		});
	});

	it("holds Direct completion until the runtime Reviewer approves", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subagentRuntime = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const harness = await createHarness({ subagentRuntime });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct", false, MAIN_REVIEWER_PROTOCOL);
		harness.setResponses([fauxAssistantMessage("Implemented without calling a Reviewer")]);

		const prompt = harness.session.prompt("Implement a CLI change");
		await vi.waitFor(() => expect(factory.sessions).toHaveLength(1));
		expect(harness.session.getWorkflowView()?.workflow.status).toBe("executing");
		expect(harness.session.getWorkflowView()?.rootTask?.status).toBe("verifying");
		expect(factory.sessions[0]?.config.profile.name).toBe("reviewer");
		factory.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Delivery review passed",
				verificationSummary: ["review:passed"],
			}),
		);
		await prompt;

		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: { status: "completed" },
			agents: [expect.objectContaining({ profileName: "reviewer", handoffId: expect.any(String) })],
			executionProtocol: {
				satisfied: true,
				requirements: [
					expect.objectContaining({
						id: "reviewer-before-delivery",
						succeededRuns: 1,
						satisfied: true,
					}),
				],
			},
		});
	});

	it("runs a balanced Plan Lite contract and deterministic verification before Reviewer", async () => {
		const factory = new FakeSubagentSessionFactory();
		const verificationFactory = new SequencedVerificationFactory([0]);
		const subagentRuntime = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: routingGateway(),
		});
		const harness = await createHarness({
			subagentRuntime,
			jobRuntime: new JobRuntime({
				processFactory: verificationFactory,
				runtimeRegistry: new WorkflowRuntimeRegistry(),
			}),
			models: [
				{ id: "faux-strong", name: "Faux Strong" },
				{ id: "faux-fast", name: "Faux Fast" },
				{ id: "faux-balanced", name: "Faux Balanced" },
			],
			modelRouting: {
				enabled: true,
				fastModel: "faux/faux-fast",
				balancedModel: "faux/faux-balanced",
				strongModel: "faux/faux-strong",
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking(
			"direct",
			false,
			DIRECT_PLANNER_LITE_REVIEWER_PROTOCOL,
			{ maxDurationMs: 60_000 },
			["node --test"],
		);
		harness.setResponses([fauxAssistantMessage("Implemented from the execution contract")]);

		const prompt = harness.session.prompt("Fix a bounded asynchronous cache bug");
		await vi.waitFor(() => expect(factory.sessions).toHaveLength(1));
		expect(factory.sessions[0]?.config.profile.name).toBe("planner-lite");
		factory.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Edit src/cache.ts, preserve in-flight sharing, then run node --test",
				evidence: [{ path: "src/cache.ts", line: 10, note: "Cache implementation" }],
				verificationSummary: ["Run node --test after implementation"],
			}),
		);
		await vi.waitFor(() => expect(factory.sessions).toHaveLength(2));
		expect(verificationFactory.commands).toEqual(["node --test"]);
		expect(factory.sessions[1]?.config.profile.name).toBe("reviewer");
		factory.sessions[1]?.complete(
			subagentHandoff({
				conclusion: "Delivery review passed",
				verificationSummary: ["review:passed"],
			}),
		);
		await prompt;

		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "custom" &&
					message.customType === "workflow-protocol-handoff" &&
					getMessageText(message).includes("Execution Contract"),
			),
		).toBe(true);
		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: { status: "completed" },
			agents: [
				expect.objectContaining({
					profileName: "planner-lite",
					modelRoute: expect.objectContaining({ role: "planner_lite", tier: "balanced" }),
				}),
				expect.objectContaining({ profileName: "reviewer" }),
			],
			executionProtocol: {
				satisfied: true,
				requirements: [
					expect.objectContaining({ id: "planner-lite-before-main", succeededRuns: 1 }),
					expect.objectContaining({ id: "reviewer-before-delivery", succeededRuns: 1 }),
				],
			},
		});
	});

	it("blocks Reviewer and gives Strong Repair the contract, diff, and failed test log", async () => {
		const factory = new FakeSubagentSessionFactory();
		const verificationFactory = new SequencedVerificationFactory([1, 1]);
		const subagentRuntime = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: routingGateway(),
		});
		const harness = await createHarness({
			subagentRuntime,
			jobRuntime: new JobRuntime({
				processFactory: verificationFactory,
				runtimeRegistry: new WorkflowRuntimeRegistry(),
			}),
			models: [
				{ id: "faux-strong", name: "Faux Strong" },
				{ id: "faux-fast", name: "Faux Fast" },
				{ id: "faux-balanced", name: "Faux Balanced" },
			],
			modelRouting: {
				enabled: true,
				fastModel: "faux/faux-fast",
				balancedModel: "faux/faux-balanced",
				strongModel: "faux/faux-strong",
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking(
			"direct",
			false,
			DIRECT_PLANNER_LITE_REVIEWER_PROTOCOL,
			{ maxDurationMs: 60_000 },
			["node --test"],
		);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "src/cache.ts", content: "export const cache = true;\n" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Initial implementation"),
			fauxAssistantMessage("Repair attempted"),
		]);

		const prompt = harness.session.prompt("Fix a bounded asynchronous cache bug");
		await vi.waitFor(() => expect(factory.sessions).toHaveLength(1));
		factory.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Edit src/cache.ts and verify in-flight sharing",
				evidence: [{ path: "src/cache.ts", line: 1, note: "Cache implementation" }],
				verificationSummary: ["Run node --test"],
			}),
		);
		await expect(prompt).rejects.toThrow("still failed after Repair");

		expect(factory.sessions).toHaveLength(1);
		expect(verificationFactory.commands).toEqual(["node --test", "node --test"]);
		const repairMessage = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "workflow-protocol-repair",
		);
		const repairText = getMessageText(repairMessage);
		expect(repairText).toContain("Execution Contract");
		expect(repairText).toContain("src/cache.ts");
		expect(repairText).toContain("assertion mismatch");
		const verificationEntries = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "workflow-direct-verification");
		expect(verificationEntries).toHaveLength(2);
		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: { status: "failed" },
			modelRoutes: [
				expect.objectContaining({ role: "main", tier: "fast" }),
				expect.objectContaining({
					role: "repair",
					tier: "strong",
					reasonCode: "model.verification_failure_escalated_strong",
				}),
			],
		});
	});

	it("runs one bounded Repair and re-reviews a failed Direct delivery", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subagentRuntime = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: routingGateway(),
		});
		const harness = await createHarness({
			subagentRuntime,
			models: [
				{ id: "faux-strong", name: "Faux Strong" },
				{ id: "faux-fast", name: "Faux Fast" },
				{ id: "faux-balanced", name: "Faux Balanced" },
			],
			modelRouting: {
				enabled: true,
				fastModel: "faux/faux-fast",
				balancedModel: "faux/faux-balanced",
				strongModel: "faux/faux-strong",
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct", false, {
			...MAIN_REVIEWER_PROTOCOL,
			requirements: [
				{
					...MAIN_REVIEWER_PROTOCOL.requirements[0],
					maxRuns: 2,
					failurePolicy: "retry_once",
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("Initial implementation"),
			fauxAssistantMessage("Repaired implementation"),
		]);

		const prompt = harness.session.prompt("Implement a CLI change");
		await vi.waitFor(() => expect(factory.sessions).toHaveLength(1));
		factory.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "A correctness issue remains",
				verificationSummary: ["review:failed"],
				unfinishedItems: ["Fix the incorrect branch"],
			}),
		);
		await vi.waitFor(() => expect(factory.sessions).toHaveLength(2));
		factory.sessions[1]?.complete(
			subagentHandoff({
				conclusion: "Repair resolved the issue",
				verificationSummary: ["review:passed"],
			}),
		);
		await prompt;

		const { store, workflowId } = replayWorkflow(harness);
		const workflow = store.getWorkflow(workflowId);
		const rootTask = workflow?.rootTaskId ? store.getTask(workflow.rootTaskId) : undefined;
		expect(rootTask ? store.listAttempts(rootTask.id) : []).toHaveLength(2);
		expect(store.listVerifications(workflowId).map(({ status }) => status)).toEqual(["failed", "passed"]);
		expect(subagentRuntime.list(workflowId).map(({ modelRoute }) => modelRoute)).toMatchObject([
			{ tier: "balanced", reasonCode: "model.reviewer.balanced" },
			{ tier: "balanced", reasonCode: "model.retry_role_tier" },
		]);
		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: { status: "completed" },
			modelRoutes: [
				expect.objectContaining({ role: "main", tier: "fast" }),
				expect.objectContaining({
					role: "repair",
					tier: "strong",
					reasonCode: "model.verification_failure_escalated_strong",
				}),
			],
			executionProtocol: {
				satisfied: true,
				requirements: [
					expect.objectContaining({
						failedRuns: 1,
						succeededRuns: 1,
					}),
				],
			},
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
		expect(getMessageText(message)).toContain("direct | completed | root:");
		expect(getMessageText(message)).toContain("1 task | 0 files | tests: not configured");
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
		expect(getMessageText(statusMessage)).toContain("direct | executing | root:");
		expect(getMessageText(statusMessage)).toContain("(running) | attempt: 1");
		expect(harness.session.pendingMessageCount).toBe(0);

		await harness.session.prompt("/cancel User cancelled the workflow", { streamingBehavior: "steer" });
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
