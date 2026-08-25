import { existsSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContent } from "../../src/core/workflow/index.ts";
import { SessionWorkflowEventLog, WorkflowStore } from "../../src/core/workflow/index.ts";
import {
	type JobProcess,
	type JobProcessExit,
	type JobProcessFactory,
	JobRuntime,
	type ReadonlyReviewer,
	type ReviewResult,
	type StartJobProcessInput,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "../workflow/subagent-fixtures.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function planContent(goal: string, secondTitle = "Add tests"): PlanContent {
	return {
		goal,
		assumptions: ["The current CLI architecture remains in place"],
		steps: [
			{
				id: "step-1",
				title: "Implement Plan lifecycle",
				description: "Add the Plan lifecycle to the Workflow Controller",
				dependsOn: [],
				fileIntents: [
					{
						path: "src/plan.ts",
						action: "modify",
						reason: "Implement Plan lifecycle",
					},
				],
				verificationRequirementIds: ["verify-plan"],
			},
			{
				id: "step-2",
				title: secondTitle,
				description: "Add regression coverage for Plan lifecycle",
				dependsOn: ["step-1"],
				fileIntents: [
					{
						path: "test/plan.test.ts",
						action: "create",
						reason: "Cover Plan lifecycle",
					},
				],
				verificationRequirementIds: ["verify-plan"],
			},
		],
		risks: [
			{
				level: "medium",
				description: "Approval state could diverge",
				mitigation: "Persist decisions in the Workflow Event Log",
			},
		],
		verificationRequirements: [
			{
				id: "verify-plan",
				kind: "test",
				description: "Run Plan regression tests",
				required: true,
			},
		],
	};
}

function subagentPlanContent(): PlanContent {
	return {
		goal: "Inspect the CLI Workflow",
		assumptions: [],
		steps: [
			{
				id: "inspect-step",
				title: "Inspect Workflow integration",
				description: "Inspect the CLI Workflow without changing files",
				dependsOn: [],
				fileIntents: [
					{
						path: "src/core/agent-session.ts",
						action: "inspect",
						reason: "Locate CLI integration",
					},
				],
				verificationRequirementIds: ["inspect-evidence"],
			},
			{
				id: "summarize-step",
				title: "Summarize Workflow integration",
				description: "Summarize the prior inspection",
				dependsOn: ["inspect-step"],
				fileIntents: [
					{
						path: "src/core/workflow/plan-runtime.ts",
						action: "inspect",
						reason: "Trace Task completion",
					},
				],
				verificationRequirementIds: ["inspect-evidence"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "inspect-evidence",
				kind: "manual",
				description: "Return exact source evidence",
				required: true,
			},
		],
	};
}

function jobPlanContent(): PlanContent {
	return {
		goal: "Run CLI verification",
		assumptions: [],
		steps: [
			{
				id: "check-step",
				kind: "command",
				command: "npm run check",
				title: "Run checks",
				description: "Run deterministic repository checks",
				dependsOn: [],
				fileIntents: [],
				verificationRequirementIds: ["check"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "check",
				kind: "test",
				description: "Checks pass",
				command: "npm run check",
				required: true,
			},
		],
	};
}

class CliJobProcess implements JobProcess {
	readonly pid = 9001;
	readonly #input: StartJobProcessInput;
	readonly #exitCode: number;

	constructor(input: StartJobProcessInput, exitCode = 0) {
		this.#input = input;
		this.#exitCode = exitCode;
	}

	async wait(): Promise<JobProcessExit> {
		this.#input.onStdout(this.#exitCode === 0 ? "check passed\n" : "check failed\n");
		return { exitCode: this.#exitCode };
	}

	async terminate(): Promise<void> {}
}

class CliJobProcessFactory implements JobProcessFactory {
	start(input: StartJobProcessInput): JobProcess {
		return new CliJobProcess(input);
	}
}

class SequencedCliJobProcessFactory implements JobProcessFactory {
	readonly #exitCodes: number[];

	constructor(exitCodes: readonly number[]) {
		this.#exitCodes = [...exitCodes];
	}

	start(input: StartJobProcessInput): JobProcess {
		return new CliJobProcess(input, this.#exitCodes.shift() ?? 0);
	}
}

class CliPassingReviewer implements ReadonlyReviewer {
	async review(): Promise<ReviewResult> {
		return {
			status: "passed",
			summary: "Readonly review passed",
			evidenceRefs: ["src/core/agent-session.ts:1763"],
			risks: [],
			unfinishedItems: [],
		};
	}
}

function replay(harness: Harness): {
	readonly store: WorkflowStore;
	readonly workflowId: string;
} {
	const batches = new SessionWorkflowEventLog(harness.sessionManager).read();
	const workflowId = batches[0]?.batch.workflowId;
	if (!workflowId) {
		throw new Error("Expected a Plan Workflow");
	}
	const store = new WorkflowStore();
	store.replay(batches);
	return { store, workflowId };
}

describe("Plan Workflow AgentSession integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs a read-only Planner, waits for approval, then materializes Tasks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(planContent("Implement formal Plan Mode")))]);
		let plannerToolNames: string[] = [];
		const streamFunction = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			plannerToolNames = (context.tools ?? []).map(({ name }) => name);
			return streamFunction(model, context, options);
		};

		await harness.session.prompt("/plan");
		expect(harness.faux.state.callCount).toBe(0);
		await harness.session.prompt("Plan a multi-file CLI change");

		let replayed = replay(harness);
		let workflow = replayed.store.getWorkflow(replayed.workflowId);
		const plan = workflow?.currentPlanId ? replayed.store.getPlan(workflow.currentPlanId) : undefined;
		expect(plannerToolNames).not.toContain("bash");
		expect(plannerToolNames).not.toContain("edit");
		expect(plannerToolNames).not.toContain("write");
		expect(workflow?.status).toBe("awaiting_approval");
		expect(plan).toMatchObject({
			status: "awaiting_approval",
			goal: "Implement formal Plan Mode",
		});
		expect(existsSync(`${harness.tempDir}/src/plan.ts`)).toBe(false);

		await harness.session.prompt("/approve reviewed");

		replayed = replay(harness);
		workflow = replayed.store.getWorkflow(replayed.workflowId);
		const tasks = replayed.store
			.listTasks(replayed.workflowId)
			.filter(({ sourcePlanId }) => sourcePlanId === workflow?.currentPlanId);
		expect(workflow?.status).toBe("executing");
		expect(tasks).toHaveLength(2);
		expect(replayed.store.getPlan(workflow?.currentPlanId ?? "")).toMatchObject({
			status: "approved",
			decisionHistory: [{ action: "approved", comment: "reviewed" }],
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("preserves a Planner provider error instead of reporting malformed JSON", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '402: {"message":"Insufficient Balance"}',
			}),
		]);

		await harness.session.prompt("/plan");
		await expect(harness.session.prompt("Plan a CLI change")).rejects.toThrow(
			'402: {"message":"Insufficient Balance"}',
		);
	});

	it("creates a new Plan version for replan and preserves the old decision history", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([
			fauxAssistantMessage(JSON.stringify(planContent("Initial Plan"))),
			fauxAssistantMessage(JSON.stringify(planContent("Revised Plan", "Split integration tests"))),
		]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Plan a risky CLI change");
		await harness.session.prompt("/replan Split the test work");
		await harness.session.prompt("Use separate unit and integration tests");

		const { store, workflowId } = replay(harness);
		const plans = store.listPlans(workflowId);
		expect(plans).toHaveLength(2);
		expect(plans[0]).toMatchObject({
			status: "superseded",
			decisionHistory: [{ action: "revision_requested", comment: "Split the test work" }],
		});
		expect(plans[1]).toMatchObject({
			status: "awaiting_approval",
			version: 2,
			supersedesPlanId: plans[0]?.id,
			goal: "Revised Plan",
		});
		expect(store.getWorkflow(workflowId)?.currentPlanId).toBe(plans[1]?.id);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("rejects the current Plan without another provider call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(planContent("Rejected Plan")))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Plan a CLI change");
		await harness.session.prompt("/reject Too risky");

		const { store, workflowId } = replay(harness);
		const workflow = store.getWorkflow(workflowId);
		expect(workflow).toMatchObject({
			status: "cancelled",
			result: {
				reason: "Too risky",
			},
		});
		expect(store.getPlan(workflow?.currentPlanId ?? "")).toMatchObject({
			status: "rejected",
			decisionHistory: [{ action: "rejected", comment: "Too risky" }],
		});
		expect(harness.faux.state.callCount).toBe(1);

		await harness.session.prompt("/workflow");
		const message = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.slice()
			.reverse()
			.find((candidate) => candidate.role === "custom" && candidate.customType === "workflow");
		expect(getMessageText(message)).toContain("plan | cancelled | root:");
		expect(getMessageText(message)).toContain("Plan v1: rejected");
	});

	it("shows the Task tree and supports Task inspection and cancellation without provider calls", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(planContent("Task CLI")))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Plan a Task CLI change");
		await harness.session.prompt("/approve");
		let replayed = replay(harness);
		const planId = replayed.store.getWorkflow(replayed.workflowId)?.currentPlanId;
		const firstTask = replayed.store
			.listTasks(replayed.workflowId)
			.find(({ sourcePlanId, sourcePlanStepId }) => sourcePlanId === planId && sourcePlanStepId === "step-1");
		const secondTask = replayed.store
			.listTasks(replayed.workflowId)
			.find(({ sourcePlanId, sourcePlanStepId }) => sourcePlanId === planId && sourcePlanStepId === "step-2");
		if (!firstTask || !secondTask) {
			throw new Error("Expected materialized Plan Tasks");
		}

		await harness.session.prompt("/tasks");
		await harness.session.prompt(`/task show ${firstTask.id}`);
		await harness.session.prompt(`/task cancel ${firstTask.id} Superseded`);

		const workflowMessages = harness
			.eventsOfType("message_end")
			.map(({ message }) => message)
			.filter((message) => message.role === "custom" && message.customType === "workflow");
		expect(workflowMessages.map(getMessageText).join("\n")).toContain("Dispatchable:");
		expect(workflowMessages.map(getMessageText).join("\n")).toContain(`Task ${firstTask.id}`);
		replayed = replay(harness);
		expect(replayed.store.getTask(firstTask.id)?.status).toBe("cancelled");
		expect(replayed.store.getTask(secondTask.id)).toMatchObject({
			status: "blocked",
			blockedReason: { code: "dependency_failed" },
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("dispatches a ready Task to an isolated Subagent and exposes Agent CLI status", async () => {
		const factory = new FakeSubagentSessionFactory();
		let sequence = 0;
		const subagentRuntime = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			createId: (kind) => `${kind}-${++sequence}`,
		});
		const harness = await createHarness({ subagentRuntime });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(subagentPlanContent()))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Inspect the CLI Workflow");
		await harness.session.prompt("/approve");
		await harness.session.prompt("/agents dispatch 1");

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.config.toolNames).toEqual(["read", "grep", "find", "ls"]);
		factory.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "CLI Workflow inspected",
				evidence: [{ path: "src/core/agent-session.ts", line: 1422, note: "Workflow commands" }],
			}),
		);
		await harness.session.prompt("/agent wait agent-1");
		await harness.session.prompt("/agents dispatch 1");
		expect(factory.sessions).toHaveLength(2);
		expect(factory.sessions[1]?.promptCalls[0]).toContain("Dependency Handoff:");
		expect(factory.sessions[1]?.promptCalls[0]).toContain("CLI Workflow inspected");
		factory.sessions[1]?.complete(
			subagentHandoff({
				conclusion: "CLI Workflow summarized",
				evidence: [{ path: "src/core/workflow/plan-runtime.ts", line: 190, note: "Task completion" }],
			}),
		);
		await harness.session.prompt("/agent wait agent-3");
		await harness.session.prompt("/agent show agent-1");
		await harness.session.prompt("/agent sessions");
		await harness.session.prompt("/agent transcript agent-1");
		await harness.session.prompt("/agent profiles");
		await harness.session.prompt("/agent profile explorer");
		await harness.session.prompt("/agents");

		const replayed = replay(harness);
		const task = replayed.store
			.listTasks(replayed.workflowId)
			.find(({ sourcePlanStepId }) => sourcePlanStepId === "inspect-step");
		expect(task).toMatchObject({
			status: "succeeded",
			assignment: {
				executorKind: "subagent",
				agentId: "agent-1",
				agentProfile: "explorer",
			},
			result: {
				handoffId: "handoff-2",
				summary: "CLI Workflow inspected",
			},
		});
		expect(
			replayed.store
				.listTasks(replayed.workflowId)
				.find(({ sourcePlanStepId }) => sourcePlanStepId === "summarize-step"),
		).toMatchObject({
			status: "succeeded",
			result: {
				handoffId: "handoff-4",
				summary: "CLI Workflow summarized",
			},
		});
		const workflowOutput = harness
			.eventsOfType("message_end")
			.map(({ message }) => message)
			.filter((message) => message.role === "custom" && message.customType === "workflow")
			.map(getMessageText)
			.join("\n");
		expect(workflowOutput).toContain("Dispatched 1 Subagent.");
		expect(workflowOutput).toContain("agent-1 | idle | explorer");
		expect(workflowOutput).toContain("agent-3 | idle | explorer");
		expect(workflowOutput).toContain("handoff-2 | CLI Workflow inspected");
		expect(workflowOutput).toContain("session-1 | rpc | idle | released");
		expect(workflowOutput).toContain("assistant |");
		expect(workflowOutput).toContain("explorer | explorer | builtin");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("dispatches a Command Task and exposes Job status and incremental logs", async () => {
		const jobRuntime = new JobRuntime({
			processFactory: new CliJobProcessFactory(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const harness = await createHarness({ jobRuntime });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(jobPlanContent()))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Run CLI verification");
		await harness.session.prompt("/approve");
		await harness.session.prompt("/jobs dispatch 1");
		const job = jobRuntime.jobs()[0];
		if (!job) {
			throw new Error("Expected a dispatched Job");
		}
		await harness.session.prompt(`/job wait ${job.id}`);
		await harness.session.prompt(`/job logs ${job.id}`);
		await harness.session.prompt(`/job show ${job.id}`);
		await harness.session.prompt("/jobs");

		const output = harness
			.eventsOfType("message_end")
			.map(({ message }) => message)
			.filter((message) => message.role === "custom" && message.customType === "workflow")
			.map(getMessageText)
			.join("\n");
		expect(output).toContain("Dispatched 1 Job.");
		expect(output).toContain(`${job.id} | succeeded`);
		expect(output).toContain("stdout: check passed");
		expect(replay(harness).store.listTasks(replay(harness).workflowId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "command",
					status: "succeeded",
					assignment: expect.objectContaining({ executorKind: "job", jobId: job.id }),
				}),
			]),
		);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("runs the delivery gate and resumes its persisted terminal report without provider calls", async () => {
		const jobRuntime = new JobRuntime({
			processFactory: new CliJobProcessFactory(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const harness = await createHarness({
			jobRuntime,
			deliveryReviewer: new CliPassingReviewer(),
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(jobPlanContent()))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Run and verify the CLI workflow");
		await harness.session.prompt("/approve");
		await harness.session.prompt("/jobs dispatch 1");
		const implementationJob = jobRuntime.jobs()[0];
		if (!implementationJob) {
			throw new Error("Expected an implementation Job");
		}
		await harness.session.prompt(`/job wait ${implementationJob.id}`);
		await harness.session.prompt("/verify");

		const { store, workflowId } = replay(harness);
		expect(store.getWorkflow(workflowId)?.status).toBe("completed");
		expect(store.listVerifications(workflowId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					requirementId: "check",
					status: "passed",
				}),
			]),
		);

		await harness.session.prompt("/workflow-resume list");
		await harness.session.prompt(`/workflow-resume continue ${workflowId}`);

		const output = harness
			.eventsOfType("message_end")
			.map(({ message }) => message)
			.filter((message) => message.role === "custom" && message.customType === "workflow")
			.map(getMessageText)
			.join("\n");
		expect(output).toContain("plan | completed | root:");
		expect(output).toContain("1/1 tasks");
		expect(output).toContain(`${workflowId} | completed`);
		expect(output).toContain("Verifications:");
		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: { id: workflowId, status: "completed" },
			availableActions: ["resume"],
			jobs: expect.arrayContaining([expect.objectContaining({ id: implementationJob.id, status: "succeeded" })]),
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("repairs a failed delivery check through CLI Agent and Job controls", async () => {
		const factory = new FakeSubagentSessionFactory();
		const subagentRuntime = new SubagentRuntime({
			sessionFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const jobRuntime = new JobRuntime({
			processFactory: new SequencedCliJobProcessFactory([0, 1, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const harness = await createHarness({
			subagentRuntime,
			jobRuntime,
			deliveryReviewer: new CliPassingReviewer(),
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(jobPlanContent()))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Run, repair, and verify the CLI workflow");
		await harness.session.prompt("/approve");
		await harness.session.prompt("/jobs dispatch 1");
		const implementationJob = jobRuntime.jobs()[0];
		if (!implementationJob) {
			throw new Error("Expected an implementation Job");
		}
		await harness.session.prompt(`/job wait ${implementationJob.id}`);
		await harness.session.prompt("/verify");

		const { workflowId } = replay(harness);
		const repairTask = replay(harness)
			.store.listTasks(workflowId)
			.find(({ kind }) => kind === "repair");
		expect(repairTask?.status).toBe("ready");

		await harness.session.prompt("/agents dispatch 1");
		const repairAgent = subagentRuntime.list(workflowId)[0];
		if (!repairAgent || !factory.sessions[0]) {
			throw new Error("Expected a Repair Agent");
		}
		factory.sessions[0].complete(
			subagentHandoff({
				conclusion: "Repair completed",
				evidence: [{ path: "src/repair.ts", line: 1, note: "Failure corrected" }],
				verificationSummary: ["Repair applied"],
			}),
		);
		await harness.session.prompt(`/agent wait ${repairAgent.id}`);
		await harness.session.prompt("/verify");
		await harness.session.prompt(`/workflow-resume continue ${workflowId}`);

		const view = harness.session.getWorkflowView();
		expect(view).toMatchObject({
			workflow: { id: workflowId, status: "completed" },
			availableActions: ["resume"],
			tasks: expect.arrayContaining([expect.objectContaining({ kind: "repair", status: "succeeded" })]),
			agents: expect.arrayContaining([expect.objectContaining({ id: repairAgent.id, status: "idle" })]),
		});
		expect(view?.verifications.some(({ status }) => status === "failed")).toBe(true);
		expect(view?.verifications.some(({ status }) => status === "passed")).toBe(true);
		expect(jobRuntime.jobs(workflowId)).toHaveLength(3);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
