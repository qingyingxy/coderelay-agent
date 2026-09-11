import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	AutonomousWorkflowRunner,
	createWorkflowAutomationPolicy,
	DeliveryRuntime,
	type JobProcess,
	type JobProcessExit,
	type JobProcessFactory,
	JobRuntime,
	type PlanContent,
	PlanWorkflowRuntime,
	SessionWorkflowEventLog,
	SessionWorkflowSnapshotStore,
	type StartJobProcessInput,
	SubagentRuntime,
	WorkflowController,
	WorkflowRuntimeRegistry,
	WorkflowStore,
} from "../../src/index.ts";
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

	constructor(exitCodes: readonly number[]) {
		this.#exitCodes = [...exitCodes];
	}

	start(input: StartJobProcessInput): JobProcess {
		const index = this.#sequence++;
		return new SequencedProcess(8100 + index, input, this.#exitCodes[index] ?? 0);
	}
}

class HangingProcess implements JobProcess {
	readonly pid = 8200;
	#settle?: (exit: JobProcessExit) => void;
	readonly #completion = new Promise<JobProcessExit>((resolve) => {
		this.#settle = resolve;
	});

	wait(): Promise<JobProcessExit> {
		return this.#completion;
	}

	async terminate(): Promise<void> {
		this.#settle?.({ exitCode: null });
	}
}

class HangingFactory implements JobProcessFactory {
	readonly process = new HangingProcess();

	start(): JobProcess {
		return this.process;
	}
}

function createPlan(id: string): PlanWorkflowRuntime {
	const runtime = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: `workflow-${id}`,
		rootTaskId: `root-${id}`,
		planId: `plan-${id}`,
		budget: { maxRetries: 2, maxConcurrentAgents: 1, maxConcurrentJobs: 1 },
		request: {
			text: "Implement and verify automatically",
			cwd: `C:/autonomous-${id}-${Date.now()}`,
			attachments: [],
		},
	});
	runtime.submit(planContent());
	runtime.approve();
	return runtime;
}

function planContent(): PlanContent {
	return {
		goal: "Implement and verify automatically",
		assumptions: [],
		steps: [
			{
				id: "implement",
				kind: "command",
				command: "implement",
				title: "Implement",
				description: "Run deterministic implementation",
				dependsOn: [],
				fileIntents: [
					{ path: "src/fix.ts", action: "create", reason: "Simulated implementation and repair output" },
				],
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
			{
				id: "tests",
				kind: "test",
				description: "Tests pass",
				command: "test",
				required: true,
			},
		],
	};
}

function createRunner(
	plan: PlanWorkflowRuntime,
	exitCodes: readonly number[],
	sessions = new FakeSubagentSessionFactory(),
): {
	readonly runner: AutonomousWorkflowRunner;
	readonly sessions: FakeSubagentSessionFactory;
	readonly jobs: JobRuntime;
	readonly subagents: SubagentRuntime;
} {
	const jobs = new JobRuntime({
		processFactory: new SequencedFactory(exitCodes),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
	});
	const subagents = new SubagentRuntime({
		sessionFactory: sessions,
		runtimeRegistry: new WorkflowRuntimeRegistry(),
	});
	return {
		runner: new AutonomousWorkflowRunner({
			runtime: plan,
			subagentRuntime: subagents,
			jobRuntime: jobs,
			deliveryRuntime: new DeliveryRuntime({ jobRuntime: jobs }),
			policy: createWorkflowAutomationPolicy("auto", { maxConcurrency: 2 }),
		}),
		sessions,
		jobs,
		subagents,
	};
}

describe("AutonomousWorkflowRunner", () => {
	it("dispatches Command Tasks and enters Delivery without manual dispatch or verify commands", async () => {
		const plan = createPlan("complete");
		const { runner } = createRunner(plan, [0, 0]);

		const result = await runner.pump();

		expect(result).toMatchObject({
			status: "completed",
			terminal: true,
			waitingReason: "terminal",
		});
		expect(result.actions.map(({ kind }) => kind)).toEqual(["dispatch", "verification"]);
		expect(result.decisionReasonCodes).toEqual([
			"scheduler.selected",
			"automation.verification_all_tasks_succeeded",
			"automation.terminal",
		]);
		expect(plan.workflow.status).toBe("completed");
		expect(plan.verifications).toEqual(
			expect.arrayContaining([expect.objectContaining({ requirementId: "tests", status: "passed" })]),
		);
	});

	it("shares one in-flight pump and automatically dispatches Repair before re-verification", async () => {
		const plan = createPlan("repair");
		const { runner, sessions } = createRunner(plan, [0, 1, 0]);

		const first = runner.pump();
		const duplicate = runner.pump();
		expect(duplicate).toBe(first);
		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(1));
		const repairSession = sessions.sessions[0]!;
		repairSession.emit({
			type: "tool_execution_start",
			toolCallId: "repair-edit",
			toolName: "edit",
			args: { path: "src/fix.ts" },
		});
		repairSession.emit({
			type: "tool_execution_end",
			toolCallId: "repair-edit",
			toolName: "edit",
			isError: false,
		});
		repairSession.complete(
			subagentHandoff({
				conclusion: "Repair completed",
				changedFiles: ["src/fix.ts"],
				verificationSummary: ["Repair applied"],
			}),
		);

		const result = await first;

		expect(result.status).toBe("completed");
		expect(result.actions.map(({ kind }) => kind)).toEqual([
			"dispatch",
			"verification",
			"repair",
			"dispatch",
			"verification",
		]);
		expect(result.actions.find(({ kind }) => kind === "repair")).toMatchObject({
			reasonCode: "repair.verification_failed",
		});
		expect(plan.tasks.filter(({ kind }) => kind === "repair")).toHaveLength(1);
		expect(
			plan.verifications.filter(({ requirementId }) => requirementId === "tests").map(({ status }) => status),
		).toEqual(["failed", "passed"]);
	});

	it("continues an interrupted persisted Task without duplicating its prior Attempt", async () => {
		const session = SessionManager.inMemory();
		const controller = new WorkflowController(new SessionWorkflowEventLog(session), new WorkflowStore());
		controller.startPlan({
			commandId: "start",
			workflowId: "workflow-recovery",
			rootTaskId: "root-recovery",
			planId: "plan-recovery",
			request: {
				text: "Recover automatic execution",
				cwd: `C:/autonomous-recovery-${Date.now()}`,
				attachments: [],
			},
		});
		controller.submitPlanForApproval({
			commandId: "submit",
			workflowId: "workflow-recovery",
			planId: "plan-recovery",
			content: planContent(),
			plannerReadOnly: true,
		});
		controller.approvePlan({
			commandId: "approve",
			workflowId: "workflow-recovery",
			planId: "plan-recovery",
			comment: "Approved",
		});
		controller.refreshTaskReadiness({
			commandId: "ready",
			workflowId: "workflow-recovery",
		});
		const task = controller.listTasks("workflow-recovery").find(({ kind }) => kind === "command");
		if (!task) {
			throw new Error("Expected recovered Command Task");
		}
		controller.prepareTaskAttempt({
			commandId: "prepare",
			workflowId: "workflow-recovery",
			taskId: task.id,
			attemptId: "attempt-before-restart",
			assignment: { executorKind: "job", jobId: "job-before-restart" },
			writerLeaseId: task.accessMode === "writer" ? "lease-before-restart" : undefined,
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "attempt-started",
			workflowId: "workflow-recovery",
			taskId: task.id,
			attemptId: "attempt-before-restart",
		});
		new SessionWorkflowSnapshotStore(session).append(controller.createSnapshot("workflow-recovery"));

		const recovered = PlanWorkflowRuntime.recoverLatest(session, {}, "workflow-recovery");
		if (!recovered) {
			throw new Error("Expected persisted Workflow recovery");
		}
		expect(recovered.attempts).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "attempt-before-restart", status: "interrupted" })]),
		);
		expect(recovered.tasks.find(({ id }) => id === task.id)?.status).toBe("ready");
		const { runner } = createRunner(recovered, [0, 0]);

		const result = await runner.pump();

		expect(result.status).toBe("completed");
		expect(recovered.attempts.filter(({ taskId }) => taskId === task.id)).toHaveLength(2);
	});

	it("stops automatic progression before cancellation terminates active resources", async () => {
		const plan = createPlan("cancel");
		const jobs = new JobRuntime({
			processFactory: new HangingFactory(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const subagents = new SubagentRuntime({
			sessionFactory: new FakeSubagentSessionFactory(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const runner = new AutonomousWorkflowRunner({
			runtime: plan,
			subagentRuntime: subagents,
			jobRuntime: jobs,
			deliveryRuntime: new DeliveryRuntime({ jobRuntime: jobs }),
			policy: createWorkflowAutomationPolicy("auto", { maxConcurrency: 2 }),
		});

		const pumping = runner.pump();
		await vi.waitFor(() => {
			expect(jobs.jobs(plan.workflow.id)).toEqual(
				expect.arrayContaining([expect.objectContaining({ status: "running" })]),
			);
		});
		runner.stop();
		await plan.cancel("Cancelled during automatic execution", subagents, jobs);
		const result = await pumping;

		expect(result).toMatchObject({
			status: "cancelled",
			terminal: true,
			waitingReason: "terminal",
		});
		expect(plan.workflow.status).toBe("cancelled");
		expect(jobs.jobs(plan.workflow.id)).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "interrupted" })]),
		);
		expect(result.actions.filter(({ kind }) => kind === "dispatch")).toHaveLength(1);
	});
});
