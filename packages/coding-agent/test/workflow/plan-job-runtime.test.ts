import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	type JobProcess,
	type JobProcessExit,
	type JobProcessFactory,
	JobRuntime,
	PlanWorkflowRuntime,
	type StartJobProcessInput,
	WorkflowRuntimeRegistry,
} from "../../src/index.ts";

class CompletingProcess implements JobProcess {
	readonly pid = 4242;
	readonly #input: StartJobProcessInput;

	constructor(input: StartJobProcessInput) {
		this.#input = input;
	}

	async wait(): Promise<JobProcessExit> {
		this.#input.onStdout("4 tests passed\n");
		return { exitCode: 0 };
	}

	async terminate(): Promise<void> {}
}

class CompletingFactory implements JobProcessFactory {
	start(input: StartJobProcessInput): JobProcess {
		return new CompletingProcess(input);
	}
}

class HangingProcess implements JobProcess {
	readonly pid = 4343;
	readonly #completion: Promise<JobProcessExit>;
	#resolve!: (exit: JobProcessExit) => void;

	constructor() {
		this.#completion = new Promise((resolve) => {
			this.#resolve = resolve;
		});
	}

	wait(): Promise<JobProcessExit> {
		return this.#completion;
	}

	async terminate(): Promise<void> {
		this.#resolve({ exitCode: null });
	}
}

class HangingFactory implements JobProcessFactory {
	start(): JobProcess {
		return new HangingProcess();
	}
}

function createCommandPlan(id: string): PlanWorkflowRuntime {
	const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: `workflow-${id}`,
		rootTaskId: `root-${id}`,
		planId: `plan-${id}`,
		request: {
			text: "Run deterministic verification",
			cwd: `C:/repo-job-${id}-${Date.now()}`,
			attachments: [],
		},
	});
	plan.submit({
		goal: "Verify the repository",
		assumptions: [],
		steps: [
			{
				id: "test",
				kind: "command",
				command: "npm run check",
				title: "Run checks",
				description: "Run the repository checks",
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
				description: "Repository checks pass",
				command: "npm run check",
				required: true,
			},
		],
	});
	plan.approve();
	return plan;
}

describe("Plan Job integration", () => {
	it("materializes a Command Task, dispatches it through Job Runtime, and completes from notification", async () => {
		const plan = createCommandPlan("success");
		const runtime = new JobRuntime({
			processFactory: new CompletingFactory(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});

		const executions = await plan.startReadyJobs(runtime, 1);
		expect(executions).toHaveLength(1);
		expect(executions[0]?.job.command).toBe("npm run check");
		await executions[0]?.completion;

		const task = plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "test");
		expect(task).toMatchObject({
			kind: "command",
			command: "npm run check",
			status: "succeeded",
			assignment: {
				executorKind: "job",
			},
		});
		expect(task?.result?.verificationIds).toHaveLength(1);
	});

	it("persists a timed-out Job as a timed-out Attempt and returns a retryable Task to Ready", async () => {
		vi.useFakeTimers();
		try {
			const plan = createCommandPlan("timeout");
			const runtime = new JobRuntime({
				processFactory: new HangingFactory(),
				runtimeRegistry: new WorkflowRuntimeRegistry(),
				terminationGraceMs: 1,
			});
			const taskId = plan.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "test")?.id;
			if (!taskId) {
				throw new Error("Expected a Command Task");
			}
			plan.refreshTaskReadiness();
			const execution = await plan.startJobTask(runtime, taskId);
			await vi.advanceTimersByTimeAsync(execution.job.timeoutMs);
			await execution.completion;

			expect(plan.tasks.find(({ id }) => id === taskId)?.status).toBe("ready");
			expect(runtime.registry.get(execution.job.id)?.status).toBe("timed_out");
			expect(plan.taskDetails(taskId).join("\n")).toContain("timed_out");
		} finally {
			vi.useRealTimers();
		}
	});
});
