import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	DeliveryRuntime,
	DiffCollector,
	type JobProcess,
	type JobProcessExit,
	type JobProcessFactory,
	JobRuntime,
	PlanWorkflowRuntime,
	type ReadonlyReviewer,
	type ReviewResult,
	type StartJobProcessInput,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { spawnProcessSync } from "../../src/utils/child-process.ts";
import { ZERO_USAGE } from "./fixtures.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "./subagent-fixtures.ts";

class SequencedProcess implements JobProcess {
	readonly pid: number;
	readonly #input: StartJobProcessInput;
	readonly #exitCode: number;

	constructor(pid: number, input: StartJobProcessInput, exitCode: number) {
		this.pid = pid;
		this.#input = input;
		this.#exitCode = exitCode;
	}

	async wait(): Promise<JobProcessExit> {
		this.#input.onStdout(`exit ${this.#exitCode}\n`);
		return { exitCode: this.#exitCode };
	}

	async terminate(): Promise<void> {}
}

class SequencedFactory implements JobProcessFactory {
	readonly #exitCodes: number[];
	#sequence = 0;

	constructor(exitCodes: number[]) {
		this.#exitCodes = exitCodes;
	}

	start(input: StartJobProcessInput): JobProcess {
		const index = this.#sequence++;
		return new SequencedProcess(7000 + index, input, this.#exitCodes[index] ?? 0);
	}
}

class PassingReviewer implements ReadonlyReviewer {
	async review(): Promise<ReviewResult> {
		return {
			status: "passed",
			summary: "Review passed",
			evidenceRefs: ["src/index.ts:1"],
			risks: [],
			unfinishedItems: [],
		};
	}
}

class ThrowingReviewer implements ReadonlyReviewer {
	async review(): Promise<ReviewResult> {
		throw new Error("Reviewer transport stopped");
	}
}

function createPlan(id: string, includeReview = false, maxRetries = 1): PlanWorkflowRuntime {
	const runtime = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: `workflow-${id}`,
		rootTaskId: `root-${id}`,
		planId: `plan-${id}`,
		budget: { maxRetries, maxConcurrentAgents: 1, maxConcurrentJobs: 1 },
		request: {
			text: "Implement and verify",
			cwd: `C:/delivery-${id}-${Date.now()}`,
			attachments: [],
		},
	});
	runtime.submit({
		goal: "Implement and verify",
		assumptions: [],
		steps: [
			{
				id: "implement",
				kind: "command",
				command: "implement",
				title: "Implement",
				description: "Apply a deterministic change",
				dependsOn: [],
				fileIntents: [],
				verificationRequirementIds: ["implementation"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "implementation",
				kind: "manual",
				description: "Implementation command completed",
				required: true,
			},
			...(includeReview
				? [
						{
							id: "review",
							kind: "review" as const,
							description: "Readonly review passes",
							required: true,
						},
					]
				: []),
			{
				id: "tests",
				kind: "test",
				description: "Tests pass",
				command: "test",
				required: true,
			},
		],
	});
	runtime.approve();
	return runtime;
}

describe("DeliveryRuntime", () => {
	it("runs Diff, readonly Review, and Test before passing the Completion Gate", async () => {
		const plan = createPlan("complete", true);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			reviewer: new PassingReviewer(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const result = await delivery.run(plan);

		expect(result.status).toBe("completed");
		expect(plan.workflow.status).toBe("completed");
		expect(plan.verifications).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ requirementId: "review", status: "passed" }),
				expect.objectContaining({ requirementId: "tests", status: "passed", command: "test" }),
			]),
		);
		expect(plan.finalReport?.lines.join("\n")).toContain("Verifications:");
	});

	it("creates a bounded Repair Task after Test failure and completes after re-verification", async () => {
		const plan = createPlan("repair");
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 1, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const failed = await delivery.run(plan);
		expect(failed).toMatchObject({
			status: "repair_created",
			repairTask: { kind: "repair", repairIteration: 1 },
		});
		expect(plan.workflow.status).toBe("executing");

		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const [repair] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Repair completed",
				changedFiles: ["src/fix.ts"],
				verificationSummary: ["Repair applied"],
			}),
			{ ...ZERO_USAGE, turns: 1 },
		);
		await repair?.completion;

		const completed = await delivery.run(plan);
		expect(completed.status).toBe("completed");
		expect(plan.workflow.status).toBe("completed");
		expect(plan.tasks.filter(({ kind }) => kind === "repair")).toHaveLength(1);
		expect(
			plan.verifications.filter(({ requirementId }) => requirementId === "tests").map(({ status }) => status),
		).toEqual(["failed", "passed"]);
	});

	it("records Reviewer runtime errors as failed Verification instead of abandoning the Workflow", async () => {
		const plan = createPlan("review-error", true);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			reviewer: new ThrowingReviewer(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const result = await delivery.run(plan);

		expect(result.status).toBe("repair_created");
		expect(plan.verifications).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					requirementId: "review",
					status: "failed",
					summary: "Readonly Reviewer failed: Reviewer transport stopped",
				}),
			]),
		);
	});

	it("fails terminally when the Repair budget is exhausted", async () => {
		const plan = createPlan("repair-limit", false, 0);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 1]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const result = await delivery.run(plan);

		expect(result.status).toBe("failed");
		expect(plan.workflow.status).toBe("failed");
		expect(plan.workflow.result?.reason).toContain("Repair limit 0 reached");
	});
});

describe("DiffCollector", () => {
	it("collects only Workflow-owned changes with Task, Attempt, and Agent ownership", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-delivery-diff-"));
		try {
			spawnProcessSync("git", ["init"], { cwd, encoding: "utf8", windowsHide: true });
			spawnProcessSync("git", ["config", "user.email", "test@example.com"], {
				cwd,
				encoding: "utf8",
				windowsHide: true,
			});
			spawnProcessSync("git", ["config", "user.name", "Test"], { cwd, encoding: "utf8", windowsHide: true });
			writeFileSync(join(cwd, "owned.txt"), "before\n");
			writeFileSync(join(cwd, "unrelated.txt"), "before\n");
			spawnProcessSync("git", ["add", "owned.txt", "unrelated.txt"], { cwd, encoding: "utf8", windowsHide: true });
			spawnProcessSync("git", ["commit", "-m", "base"], { cwd, encoding: "utf8", windowsHide: true });
			writeFileSync(join(cwd, "owned.txt"), "after\n");
			writeFileSync(join(cwd, "unrelated.txt"), "user change\n");
			const task = {
				schemaVersion: 1,
				revision: 1,
				createdAt: "2026-07-27T00:00:00.000Z",
				updatedAt: "2026-07-27T00:00:00.000Z",
				id: "task-1",
				workflowId: "workflow-1",
				kind: "agent" as const,
				accessMode: "writer" as const,
				title: "Change owned file",
				description: "Change owned file",
				status: "succeeded" as const,
				dependencyIds: [],
				assignment: { executorKind: "subagent" as const, agentId: "agent-1" },
				budget: {},
				usage: ZERO_USAGE,
				attemptIds: ["attempt-1"],
				currentAttemptId: "attempt-1",
				verificationRequirements: [],
				modifications: [
					{
						path: "owned.txt",
						operation: "edit" as const,
						workflowId: "workflow-1",
						taskId: "task-1",
						attemptId: "attempt-1",
						agentId: "agent-1",
						toolCallId: "tool-1",
						recordedAt: "2026-07-27T00:00:00.000Z",
					},
				],
				result: {
					summary: "done",
					changedFiles: ["owned.txt"],
					verificationIds: [],
					completedAt: "2026-07-27T00:00:00.000Z",
				},
			};

			const diff = new DiffCollector().collect(cwd, [task]);

			expect(diff.changedFiles).toEqual(["owned.txt"]);
			expect(diff.files[0]?.patch).toContain("-before");
			expect(diff.files[0]?.patch).toContain("+after");
			expect(diff.files[0]?.owners[0]).toMatchObject({
				taskId: "task-1",
				attemptId: "attempt-1",
				agentId: "agent-1",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
