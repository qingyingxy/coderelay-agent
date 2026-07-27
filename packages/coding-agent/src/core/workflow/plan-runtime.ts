import { randomUUID } from "node:crypto";
import type { SessionManager } from "../session-manager.ts";
import { aggregateHandoffs } from "../subagents/handoff.ts";
import type { SubagentRuntime } from "../subagents/subagent-runtime.ts";
import type { AgentInstance, AgentRunResult } from "../subagents/types.ts";
import { type AgentProfileRole, BUILTIN_AGENT_PROFILES } from "./agent-profile.ts";
import { WorkflowController, type WorkflowControllerOptions } from "./controller.ts";
import { SessionWorkflowEventLog } from "./event-log.ts";
import { derivePlanProgress } from "./plan-progress.ts";
import {
	evaluateBudget,
	FULL_PERMISSION_SET,
	formatBudgetEvaluation,
	type PermissionSet,
	sumResourceUsage,
} from "./runtime-policy.ts";
import { DEFAULT_WORKFLOW_RUNTIME_REGISTRY } from "./runtime-registry.ts";
import { type TaskDispatch, TaskScheduler } from "./scheduler.ts";
import { WorkflowStore } from "./stores.ts";
import { formatTaskDetails, formatTaskTree } from "./task-report.ts";
import { isWorkflowTerminalStatus } from "./transitions.ts";
import type { Plan, PlanContent, PlanProgress, Task, UserRequest, Workflow } from "./types.ts";
import { DEFAULT_WRITER_LEASE_REGISTRY } from "./writer-lease.ts";

export interface StartPlanRuntimeInput {
	readonly request: UserRequest;
	readonly workflowId?: string;
	readonly rootTaskId?: string;
	readonly planId?: string;
}

export interface StartSubagentTaskInput {
	readonly profileRole?: Extract<AgentProfileRole, "explorer" | "worker" | "reviewer">;
	readonly parentAgentId?: string;
	readonly parentPermission?: PermissionSet;
	readonly workflowPermission?: PermissionSet;
	readonly retryAgentId?: string;
}

export interface SubagentTaskExecution {
	readonly agent: AgentInstance;
	readonly completion: Promise<AgentRunResult>;
}

export class PlanWorkflowRuntime {
	readonly #controller: WorkflowController;
	readonly #workflowId: string;
	readonly #createId: (kind: "command" | "plan") => string;

	private constructor(
		controller: WorkflowController,
		workflowId: string,
		createId: (kind: "command" | "plan") => string,
	) {
		this.#controller = controller;
		this.#workflowId = workflowId;
		this.#createId = createId;
	}

	static start(
		sessionManager: SessionManager,
		input: StartPlanRuntimeInput,
		controllerOptions: WorkflowControllerOptions = {},
	): PlanWorkflowRuntime {
		const createId = (kind: "command" | "plan"): string => `${kind}-${randomUUID()}`;
		const workflowId = input.workflowId ?? `workflow-${randomUUID()}`;
		const controller = new WorkflowController(
			new SessionWorkflowEventLog(sessionManager),
			new WorkflowStore(),
			controllerOptions,
		);
		controller.startPlan({
			commandId: createId("command"),
			workflowId,
			rootTaskId: input.rootTaskId ?? `task-${randomUUID()}`,
			planId: input.planId ?? createId("plan"),
			request: input.request,
		});
		return new PlanWorkflowRuntime(controller, workflowId, createId);
	}

	static recoverLatest(
		sessionManager: SessionManager,
		controllerOptions: WorkflowControllerOptions = {},
	): PlanWorkflowRuntime | undefined {
		const store = new WorkflowStore();
		const controller = new WorkflowController(new SessionWorkflowEventLog(sessionManager), store, controllerOptions);
		const workflow = store
			.listWorkflows()
			.filter((candidate) => candidate.modeDecision?.mode === "plan")
			.at(-1);
		if (!workflow) {
			return undefined;
		}
		const createId = (kind: "command" | "plan"): string => `${kind}-${randomUUID()}`;
		return new PlanWorkflowRuntime(controller, workflow.id, createId);
	}

	get workflow(): Workflow {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		if (!workflow) {
			throw new Error(`Workflow ${this.#workflowId} does not exist`);
		}
		return workflow;
	}

	get currentPlan(): Plan {
		const workflow = this.workflow;
		const plan = workflow.currentPlanId ? this.#controller.getPlan(workflow.currentPlanId) : undefined;
		if (!plan) {
			throw new Error(`Workflow ${workflow.id} has no current Plan`);
		}
		return plan;
	}

	get tasks(): readonly Task[] {
		return this.#controller.listTasks(this.#workflowId);
	}

	get progress(): PlanProgress {
		return derivePlanProgress(this.currentPlan, this.tasks);
	}

	get isTerminal(): boolean {
		return isWorkflowTerminalStatus(this.workflow.status);
	}

	get statusLines(): readonly string[] {
		const workflow = this.workflow;
		const plan = this.currentPlan;
		const progress = this.progress;
		return [
			`plan | ${workflow.status} | Plan v${plan.version}: ${plan.status} | ${progress.succeededSteps}/${progress.totalSteps} steps`,
			this.budgetStatusLine,
			this.writerLeaseStatusLine,
			`Goal: ${plan.goal || "(draft)"}`,
			...plan.steps.map((step, index) => `${index + 1}. ${step.title}`),
		];
	}

	get taskTreeLines(): readonly string[] {
		return formatTaskTree(this.#workflowId, this.tasks);
	}

	get budgetStatusLine(): string {
		const tasks = this.tasks;
		const attempts = tasks.flatMap(({ id }) => this.#controller.listAttempts(id));
		const usage = sumResourceUsage(attempts.map(({ usage: attemptUsage }) => attemptUsage));
		const activeAssignments = tasks
			.filter(({ status }) => status === "running" || status === "verifying")
			.flatMap(({ assignment }) => (assignment ? [assignment] : []));
		return formatBudgetEvaluation(
			evaluateBudget(this.workflow.budget, usage, {
				activeAgents: activeAssignments.filter(
					({ executorKind }) => executorKind === "main_agent" || executorKind === "subagent",
				).length,
				activeJobs: activeAssignments.filter(({ executorKind }) => executorKind === "job").length,
			}),
		);
	}

	get writerLeaseStatusLine(): string {
		const lease = DEFAULT_WRITER_LEASE_REGISTRY.get(this.workflow.request.cwd);
		if (!lease) {
			return "Writer Lease: available";
		}
		return lease.workflowId === this.#workflowId
			? `Writer Lease: held | ${lease.taskId}`
			: `Writer Lease: unavailable | ${lease.workflowId} | ${lease.taskId}`;
	}

	selectDispatches(maxConcurrency: number): readonly TaskDispatch[] {
		const budget = this.workflow.budget;
		return new TaskScheduler({
			maxConcurrency,
			maxConcurrentAgents: budget.maxConcurrentAgents,
			maxConcurrentJobs: budget.maxConcurrentJobs,
		}).select(this.tasks);
	}

	selectSubagentDispatches(maxConcurrency: number): readonly TaskDispatch[] {
		const budget = this.workflow.budget;
		return new TaskScheduler({
			maxConcurrency,
			maxConcurrentAgents: budget.maxConcurrentAgents,
			maxConcurrentJobs: 0,
			agentExecutorKind: "subagent",
			writerAvailable: !DEFAULT_WRITER_LEASE_REGISTRY.get(this.workflow.request.cwd),
		}).select(this.tasks);
	}

	async startSubagentTask(
		runtime: SubagentRuntime,
		taskId: string,
		input: StartSubagentTaskInput = {},
	): Promise<SubagentTaskExecution> {
		const workflow = this.workflow;
		const task = this.#controller.getTask(taskId);
		if (!task || task.workflowId !== workflow.id) {
			throw new Error(`Task ${taskId} does not exist in workflow ${workflow.id}`);
		}
		if (workflow.status !== "executing" || task.status !== "ready") {
			throw new Error(
				`Task ${task.id} cannot start while Workflow is ${workflow.status} and Task is ${task.status}`,
			);
		}
		if (task.kind === "control" || task.kind === "command") {
			throw new Error(`Task ${task.id} cannot run in a Subagent`);
		}
		const profileRole = input.profileRole ?? (task.accessMode === "writer" ? "worker" : "explorer");
		const profile = BUILTIN_AGENT_PROFILES[profileRole];
		const taskPermission: PermissionSet =
			task.accessMode === "writer"
				? { ...FULL_PERMISSION_SET, network: false }
				: {
						...FULL_PERMISSION_SET,
						write: false,
						executeCommands: false,
						network: false,
					};
		const attemptId = `attempt-${randomUUID()}`;
		const agent = input.retryAgentId
			? await runtime.retry(input.retryAgentId, { attemptId, autoStart: false })
			: await runtime.spawn({
					workflowId: workflow.id,
					taskId: task.id,
					attemptId,
					cwd: workflow.request.cwd,
					profile,
					parentAgentId: input.parentAgentId,
					parentPermission: input.parentPermission ?? FULL_PERMISSION_SET,
					workflowPermission: input.workflowPermission ?? FULL_PERMISSION_SET,
					taskPermission,
					parentBudget: workflow.budget,
					workflowBudget: workflow.budget,
					taskBudget: task.budget,
				});
		if (agent.taskId !== task.id || agent.workflowId !== workflow.id) {
			await runtime.interrupt(agent.id, "Retry Agent ownership mismatch").catch(() => undefined);
			throw new Error(`Agent ${agent.id} does not belong to Task ${task.id}`);
		}
		const writerLeaseId = runtime.reserveWriter(agent.id);
		try {
			this.#controller.prepareTaskAttempt({
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId: task.id,
				attemptId,
				assignment: {
					executorKind: "subagent",
					agentProfile: agent.profileName,
					agentId: agent.id,
					agentDepth: agent.depth,
				},
				writerLeaseId,
			});
			this.#controller.handleRuntimeEvent({
				type: "attempt_started",
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId: task.id,
				attemptId,
			});
			const dependencyHandoffs = task.dependencyIds.flatMap((dependencyId) => {
				const handoffId = this.#controller.getTask(dependencyId)?.result?.handoffId;
				const handoff = handoffId ? runtime.registry.getHandoff(handoffId) : undefined;
				return handoff ? [handoff] : [];
			});
			const promptLines = [
				`Workflow: ${workflow.id}`,
				`Task: ${task.id} | ${task.title}`,
				task.description,
				`Access mode: ${task.accessMode}`,
				`Verification requirements: ${task.verificationRequirements.map(({ description }) => description).join("; ")}`,
			];
			if (dependencyHandoffs.length > 0) {
				promptLines.push(`Dependency Handoff: ${JSON.stringify(aggregateHandoffs(dependencyHandoffs))}`);
			}
			await runtime.send(agent.id, promptLines.join("\n"));
		} catch (error) {
			await runtime.interrupt(agent.id, "Task dispatch failed").catch(() => undefined);
			throw error;
		}
		const completion = runtime.wait(agent.id).then((result) => this.#finishSubagentTask(task.id, attemptId, result));
		return { agent: runtime.registry.get(agent.id) ?? agent, completion };
	}

	async startReadySubagents(
		runtime: SubagentRuntime,
		maxConcurrency: number,
	): Promise<readonly SubagentTaskExecution[]> {
		this.refreshTaskReadiness();
		const dispatches = this.selectSubagentDispatches(maxConcurrency);
		return Promise.all(dispatches.map(({ taskId }) => this.startSubagentTask(runtime, taskId)));
	}

	taskDetails(taskId: string): readonly string[] {
		const task = this.#controller.getTask(taskId);
		if (!task || task.workflowId !== this.#workflowId) {
			throw new Error(`Task ${taskId} does not exist in workflow ${this.#workflowId}`);
		}
		return formatTaskDetails(task, this.#controller.listAttempts(task.id));
	}

	refreshTaskReadiness(): void {
		this.#controller.refreshTaskReadiness({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
		});
	}

	retryTask(taskId: string): void {
		this.#controller.retryTask({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId,
		});
	}

	cancelTask(taskId: string, reason: string): void {
		this.#controller.cancelTask({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId,
			reason,
		});
	}

	async cancel(reason = "User cancelled the workflow", subagentRuntime?: SubagentRuntime): Promise<void> {
		const workflow = this.workflow;
		if (isWorkflowTerminalStatus(workflow.status)) {
			return;
		}
		this.#controller.requestCancellation({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			reason,
		});
		await subagentRuntime?.cancelWorkflow(this.#workflowId, reason);
		const cancellation = await DEFAULT_WORKFLOW_RUNTIME_REGISTRY.cancelWorkflow(this.#workflowId, reason);
		if (cancellation.failures.length > 0) {
			throw new Error(`Failed to stop Workflow resources: ${cancellation.failures.map(({ id }) => id).join(", ")}`);
		}
		DEFAULT_WRITER_LEASE_REGISTRY.releaseWorkflow(this.#workflowId);
		const rootTaskId = workflow.rootTaskId;
		if (!rootTaskId) {
			throw new Error(`Workflow ${workflow.id} has no root Task`);
		}
		this.#controller.finishCancellation({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: rootTaskId,
			reason,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0,
				turns: 0,
				durationMs: 0,
			},
			durationMs: 0,
			runtimeResourcesStopped: true,
			writerLeaseReleased: true,
		});
	}

	submit(content: PlanContent): void {
		const plan = this.currentPlan;
		this.#controller.submitPlanForApproval({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			planId: plan.id,
			content,
			plannerReadOnly: true,
		});
	}

	approve(comment = "Approved by user"): void {
		const plan = this.currentPlan;
		this.#controller.approvePlan({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			planId: plan.id,
			comment,
		});
	}

	reject(comment: string): void {
		const plan = this.currentPlan;
		this.#controller.rejectPlan({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			planId: plan.id,
			comment,
		});
	}

	revise(comment: string): void {
		const plan = this.currentPlan;
		this.#controller.revisePlan({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			planId: plan.id,
			replacementPlanId: this.#createId("plan"),
			comment,
		});
	}

	async #finishSubagentTask(taskId: string, attemptId: string, result: AgentRunResult): Promise<AgentRunResult> {
		const workflow = this.workflow;
		if (workflow.status !== "executing") {
			return result;
		}
		const task = this.#controller.getTask(taskId);
		if (!task || task.currentAttemptId !== attemptId || task.status !== "running") {
			return result;
		}
		if (result.status === "completed" && result.handoff) {
			for (const modification of result.modifications) {
				this.#controller.recordTaskModification({
					commandId: this.#createId("command"),
					workflowId: workflow.id,
					taskId,
					modification: {
						path: modification.path,
						operation: modification.operation,
						attemptId,
						agentId: result.agentId,
						toolCallId: modification.toolCallId,
					},
				});
			}
			const requirement = task.verificationRequirements.find(({ required }) => required);
			if (!requirement) {
				throw new Error(`Task ${task.id} has no required verification`);
			}
			const verificationId = `verification-${randomUUID()}`;
			const evidenceRefs = result.handoff.evidence.map(
				({ path, line }) => `${path}${line === undefined ? "" : `:${line}`}`,
			);
			this.#controller.handleRuntimeEvent({
				type: "attempt_succeeded",
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId,
				attemptId,
				verificationId,
				requirementId: requirement.id,
				usage: result.usage,
				summary: result.handoff.conclusion,
				evidenceRefs,
			});
			this.#controller.completeTask({
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId,
				verificationId,
				summary: result.handoff.conclusion,
				changedFiles: [...new Set(result.modifications.map(({ path }) => path))],
				evidenceRefs,
				handoffId: result.handoff.id,
			});
			this.refreshTaskReadiness();
			return result;
		}
		const attempts = this.#controller.listAttempts(task.id);
		const maximumRetries = task.budget.maxRetries ?? 0;
		const willRetry = attempts.length - 1 < maximumRetries;
		this.#controller.handleRuntimeEvent({
			type: "attempt_failed",
			commandId: this.#createId("command"),
			workflowId: workflow.id,
			taskId,
			attemptId,
			usage: result.usage,
			willRetry,
			failure: {
				code: result.status === "interrupted" ? "subagent_interrupted" : "subagent_failed",
				message: result.error ?? `Subagent ${result.agentId} failed`,
			},
		});
		return result;
	}
}
