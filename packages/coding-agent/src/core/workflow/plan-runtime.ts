import { createHash, randomUUID } from "node:crypto";
import type { DeliveryWorkflowPort } from "../delivery/types.ts";
import type { JobRuntime } from "../jobs/job-runtime.ts";
import type { Job } from "../jobs/types.ts";
import type { SessionManager } from "../session-manager.ts";
import { aggregateHandoffs, STRUCTURED_HANDOFF_RETRY_INSTRUCTION } from "../subagents/handoff.ts";
import type { SubagentService } from "../subagents/subagent-service.ts";
import type { TeamTaskProposal } from "../subagents/team-types.ts";
import type { AgentInstance, AgentRunResult } from "../subagents/types.ts";
import { type AgentProfile, type AgentProfileRole, BUILTIN_AGENT_PROFILES } from "./agent-profile.ts";
import type { WorkflowContextCheckpoint, WorkflowContextProvider } from "./context-window-projection.ts";
import { WorkflowController, type WorkflowControllerOptions } from "./controller.ts";
import { SessionWorkflowEventLog, SessionWorkflowSnapshotStore } from "./event-log.ts";
import type { ModelEscalationReason } from "./model-gateway.ts";
import { derivePlanProgress } from "./plan-progress.ts";
import { buildDeliveryWorkflowFinalReport, type DeliveryWorkflowFinalReport } from "./report.ts";
import {
	evaluateBudget,
	FULL_PERMISSION_SET,
	formatBudgetEvaluation,
	type PermissionSet,
	sumResourceUsage,
} from "./runtime-policy.ts";
import { DEFAULT_WORKFLOW_RUNTIME_REGISTRY } from "./runtime-registry.ts";
import { type TaskDispatch, TaskScheduler, type TaskSchedulingDecision } from "./scheduler.ts";
import { type WorkflowSnapshot, WorkflowStore } from "./stores.ts";
import { formatTaskDetails, formatTaskTree } from "./task-report.ts";
import { isWorkflowTerminalStatus } from "./transitions.ts";
import type {
	Attempt,
	ModeDecision,
	Plan,
	PlanContent,
	PlanProgress,
	Task,
	UserRequest,
	VerificationResult,
	Workflow,
} from "./types.ts";
import { buildWorkflowView, type WorkflowView } from "./view.ts";
import { DEFAULT_WRITER_LEASE_REGISTRY } from "./writer-lease.ts";

export interface StartPlanRuntimeInput {
	readonly request: UserRequest;
	readonly workflowId?: string;
	readonly rootTaskId?: string;
	readonly planId?: string;
	readonly budget?: Workflow["budget"];
	readonly modeDecision?: ModeDecision;
}

export interface StartSubagentTaskInput {
	readonly profileRole?: Extract<AgentProfileRole, "planner" | "explorer" | "worker" | "reviewer">;
	readonly profile?: AgentProfile;
	readonly profileSource?: "builtin" | "global" | "project" | "runtime";
	readonly profileSourcePath?: string;
	readonly parentAgentId?: string;
	readonly parentPermission?: PermissionSet;
	readonly workflowPermission?: PermissionSet;
	readonly retryAgentId?: string;
}

export interface SubagentTaskExecution {
	readonly agent: AgentInstance;
	readonly completion: Promise<AgentRunResult>;
}

export interface JobTaskExecution {
	readonly job: Job;
	readonly completion: Promise<Job>;
}

export interface WorkflowTaskExecution {
	readonly taskId: string;
	readonly executorKind: "subagent" | "job";
	readonly resourceId: string;
	readonly completion: Promise<AgentRunResult | Job>;
	readonly subagent?: SubagentTaskExecution;
	readonly job?: JobTaskExecution;
}

const MINIMUM_DELIVERY_RESERVE_MS = 60_000;
const MAXIMUM_DELIVERY_RESERVE_MS = 180_000;
const MINIMUM_REPAIR_RESERVE_MS = 30_000;
const MAXIMUM_REPAIR_RESERVE_MS = 120_000;
const MAXIMUM_INITIAL_WORKER_SHARE = 0.4;
const MINIMUM_INITIAL_WORKER_MS = 90_000;
const MAXIMUM_INITIAL_WORKER_MS = 240_000;
const REVIEWER_DELIVERY_RESERVE_MS = 30_000;

function taskAttemptBudget(workflow: Workflow, task: Task, completedAttempts: number): Task["budget"] {
	const workflowDurationMs = workflow.budget.maxDurationMs;
	if (workflowDurationMs === undefined) {
		return task.budget;
	}
	const elapsedMs = Math.max(0, Date.now() - Date.parse(workflow.createdAt));
	const remainingMs = Math.max(0, workflowDurationMs - elapsedMs);
	const deliveryReserveMs =
		task.kind === "repair"
			? Math.min(MINIMUM_DELIVERY_RESERVE_MS, Math.max(1, Math.floor(workflowDurationMs * 0.1)))
			: task.recommendedAgentRole === "reviewer"
				? Math.min(REVIEWER_DELIVERY_RESERVE_MS, Math.max(1, Math.floor(workflowDurationMs * 0.05)))
				: Math.min(
						MAXIMUM_DELIVERY_RESERVE_MS,
						Math.max(MINIMUM_DELIVERY_RESERVE_MS, Math.floor(workflowDurationMs * 0.3)),
					);
	const repairReserveMs =
		completedAttempts === 0 &&
		task.kind !== "repair" &&
		task.recommendedAgentRole !== "reviewer" &&
		(task.budget.maxRetries ?? 0) > 0
			? Math.min(
					MAXIMUM_REPAIR_RESERVE_MS,
					Math.max(MINIMUM_REPAIR_RESERVE_MS, Math.floor(workflowDurationMs * 0.15)),
				)
			: 0;
	const availableMs = remainingMs - deliveryReserveMs - repairReserveMs;
	if (availableMs < 1) {
		throw new Error(
			`Workflow duration budget has ${remainingMs}ms remaining; ${deliveryReserveMs}ms is reserved for delivery verification and ${repairReserveMs}ms for repair`,
		);
	}
	const initialWorkerLimitMs =
		completedAttempts === 0 && task.accessMode === "writer" && task.recommendedAgentRole === "worker"
			? Math.min(
					MAXIMUM_INITIAL_WORKER_MS,
					Math.max(MINIMUM_INITIAL_WORKER_MS, Math.floor(workflowDurationMs * MAXIMUM_INITIAL_WORKER_SHARE)),
				)
			: availableMs;
	return {
		...task.budget,
		maxDurationMs: Math.min(task.budget.maxDurationMs ?? availableMs, availableMs, initialWorkerLimitMs),
	};
}

function workerPromptLines(
	plan: Plan,
	task: Task,
	agent: AgentInstance,
	verificationCommands: readonly string[],
): readonly string[] {
	const step = plan.steps.find(({ id }) => id === task.sourcePlanStepId);
	const fileIntents = step?.fileIntents ?? [];
	const recovery = agent.recoveryContext;
	const changedFiles = recovery?.artifact?.changedFiles ?? [];
	const diagnostics = recovery?.commandDiagnostics ?? [];
	return [
		"Execution role: implementation Worker. Do not create, restate, review, or revise a plan. Start editing after only the minimum reads needed for the listed files.",
		`Workflow goal: ${plan.goal}`,
		`Assigned Task: ${task.title}`,
		task.description,
		...(fileIntents.length > 0
			? [
					"Required file operations:",
					...fileIntents.map(({ path, action, reason }) => `- ${action} ${path}: ${reason}`),
				]
			: []),
		`Acceptance criteria:\n${task.verificationRequirements.map(({ description }) => `- ${description}`).join("\n")}`,
		...(verificationCommands.length > 0
			? [
					`Required verification commands:\n${verificationCommands.map((command) => `- ${command}`).join("\n")}`,
					"Run these commands yourself. If one fails, inspect its output, modify the code, and rerun it in this same Session until it passes or the budget is exhausted.",
				]
			: []),
		...(agent.effectivePermissions.deniedPaths.length > 0
			? [
					`Do not modify these protected paths:\n${agent.effectivePermissions.deniedPaths.map((path) => `- ${path}`).join("\n")}`,
				]
			: []),
		...(recovery
			? [
					`Previous attempt status: ${recovery.reason}`,
					changedFiles.length > 0
						? `The previous implementation has already been restored into this Workspace. Continue from these changed files: ${changedFiles.join(", ")}. Do not restart from scratch.`
						: "The previous attempt produced no code. Implement the listed file operations now; do not repeat its planning or exploration.",
					...(diagnostics.length > 0
						? [
								`Previous command diagnostics:\n${diagnostics.map(({ command, status, output }) => `- ${command}: ${status}${output ? `\n${output}` : ""}`).join("\n")}`,
							]
						: []),
				]
			: []),
		"Complete all related edits and test-driven repairs in this one Worker Session. Return the structured Handoff only after implementation and required verification.",
	];
}

function workerVerificationCommands(task: Task, tasks: readonly Task[]): readonly string[] {
	const commands = task.verificationRequirements.flatMap(({ command }) => (command ? [command] : []));
	for (const candidate of tasks) {
		if (
			candidate.kind === "command" &&
			candidate.command &&
			candidate.dependencyIds.length === 1 &&
			candidate.dependencyIds[0] === task.id &&
			candidate.verificationRequirements.some(({ required, command }) => required && command === candidate.command)
		) {
			commands.push(candidate.command);
		}
	}
	return [...new Set(commands)];
}

function retryEscalationReason(task: Task, previousAttempt: Attempt | undefined): ModelEscalationReason | undefined {
	if (task.kind === "repair") return "verification_failure";
	const failureCode = previousAttempt?.failure?.code;
	if (failureCode === "subagent.no_progress" || failureCode === "subagent.duration_exceeded") {
		return "no_progress";
	}
	if (failureCode === "subagent.verification_failed") return "verification_failure";
	return undefined;
}

function withAgentHandoffVerifications(content: PlanContent): PlanContent {
	const verificationRequirements = [...structuredClone(content.verificationRequirements)];
	const requirementsById = new Map(verificationRequirements.map((requirement) => [requirement.id, requirement]));
	const usedIds = new Set(requirementsById.keys());
	let agentSequence = 0;
	let commandSequence = 0;
	const steps = content.steps.map((step) => {
		const kind = step.kind ?? "agent";
		if (kind === "command" && step.verificationRequirementIds.length === 0 && step.command) {
			const matchingRequirement = verificationRequirements.find(
				(requirement) => requirement.required && requirement.command === step.command,
			);
			if (matchingRequirement) {
				return {
					...structuredClone(step),
					verificationRequirementIds: [matchingRequirement.id],
				};
			}
			let requirementId: string;
			do {
				requirementId = `command-verification-${++commandSequence}`;
			} while (usedIds.has(requirementId));
			usedIds.add(requirementId);
			const requirement = {
				id: requirementId,
				kind: "test" as const,
				description: `Command succeeds: ${step.command}`,
				required: true,
				command: step.command,
			};
			verificationRequirements.push(requirement);
			requirementsById.set(requirementId, requirement);
			return {
				...structuredClone(step),
				verificationRequirementIds: [requirementId],
			};
		}
		if (
			kind !== "agent" ||
			step.verificationRequirementIds.some((id) => {
				const requirement = requirementsById.get(id);
				return requirement?.required && !requirement.command;
			})
		) {
			return structuredClone(step);
		}
		let requirementId: string;
		do {
			requirementId = `agent-handoff-${++agentSequence}`;
		} while (usedIds.has(requirementId));
		usedIds.add(requirementId);
		const requirement = {
			id: requirementId,
			kind: "manual" as const,
			description: `Structured Handoff validates Agent Task: ${step.title}`,
			required: true,
		};
		verificationRequirements.push(requirement);
		requirementsById.set(requirementId, requirement);
		return {
			...structuredClone(step),
			verificationRequirementIds: [...step.verificationRequirementIds, requirementId],
		};
	});
	return { ...structuredClone(content), steps, verificationRequirements };
}

export class PlanWorkflowRuntime implements DeliveryWorkflowPort, WorkflowContextProvider {
	readonly #controller: WorkflowController;
	readonly #workflowId: string;
	readonly #createId: (kind: "command" | "plan") => string;
	readonly #snapshotStore: SessionWorkflowSnapshotStore;
	#lastSchedulingDecisions: readonly TaskSchedulingDecision[] = [];

	private constructor(
		controller: WorkflowController,
		workflowId: string,
		createId: (kind: "command" | "plan") => string,
		snapshotStore: SessionWorkflowSnapshotStore,
	) {
		this.#controller = controller;
		this.#workflowId = workflowId;
		this.#createId = createId;
		this.#snapshotStore = snapshotStore;
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
			budget: input.budget,
			modeDecision: input.modeDecision,
		});
		const snapshotStore = new SessionWorkflowSnapshotStore(sessionManager);
		const runtime = new PlanWorkflowRuntime(controller, workflowId, createId, snapshotStore);
		runtime.#checkpoint();
		return runtime;
	}

	static recoverLatest(
		sessionManager: SessionManager,
		controllerOptions: WorkflowControllerOptions = {},
		workflowId?: string,
	): PlanWorkflowRuntime | undefined {
		const snapshotStore = new SessionWorkflowSnapshotStore(sessionManager);
		const snapshot = snapshotStore.readLatest(workflowId);
		const store = new WorkflowStore();
		const controller = new WorkflowController(new SessionWorkflowEventLog(sessionManager), store, {
			...controllerOptions,
			snapshot,
		});
		const targetWorkflowId = workflowId ?? snapshot?.workflowId;
		const workflow = controller
			.listWorkflows()
			.filter((candidate) => candidate.modeDecision?.mode === "plan" || candidate.currentPlanId !== undefined)
			.filter((candidate) => targetWorkflowId === undefined || candidate.id === targetWorkflowId)
			.at(-1);
		if (!workflow) {
			return undefined;
		}
		const createId = (kind: "command" | "plan"): string => `${kind}-${randomUUID()}`;
		const runtime = new PlanWorkflowRuntime(controller, workflow.id, createId, snapshotStore);
		controller.recoverInterrupted({
			commandId: createId("command"),
			workflowId: workflow.id,
			reason: "CLI restarted before the runtime resource reported a terminal state",
		});
		DEFAULT_WRITER_LEASE_REGISTRY.releaseRecovered(workflow.id, workflow.request.cwd);
		runtime.#checkpoint();
		return runtime;
	}

	static list(sessionManager: SessionManager): readonly Workflow[] {
		const controller = new WorkflowController(new SessionWorkflowEventLog(sessionManager), new WorkflowStore());
		return controller.listWorkflows();
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

	get verifications(): readonly VerificationResult[] {
		return this.#controller.listVerifications(this.#workflowId);
	}

	get attempts(): readonly Attempt[] {
		return this.tasks.flatMap(({ id }) => this.#controller.listAttempts(id));
	}

	get progress(): PlanProgress {
		return derivePlanProgress(this.currentPlan, this.tasks);
	}

	get isTerminal(): boolean {
		return isWorkflowTerminalStatus(this.workflow.status);
	}

	checkpointForContextWindow(): WorkflowContextCheckpoint {
		return this.#checkpoint();
	}

	get deliveryFingerprint(): string {
		const plan = this.currentPlan;
		const tasks = this.tasks
			.filter(({ kind }) => kind !== "control")
			.map((task) => ({
				id: task.id,
				revision: task.revision,
				status: task.status,
				currentAttemptId: task.currentAttemptId,
				modifications: task.modifications.map(({ path, operation, attemptId, toolCallId }) => ({
					path,
					operation,
					attemptId,
					toolCallId,
				})),
			}))
			.sort((left, right) => left.id.localeCompare(right.id));
		return createHash("sha256")
			.update(
				JSON.stringify({
					planId: plan.id,
					planVersion: plan.version,
					tasks,
					requirements: plan.verificationRequirements,
				}),
			)
			.digest("hex");
	}

	get statusLines(): readonly string[] {
		const workflow = this.workflow;
		const plan = this.currentPlan;
		if (isWorkflowTerminalStatus(workflow.status) && workflow.result && plan.status === "approved") {
			return this.finalReport?.lines ?? [];
		}
		const progress = this.progress;
		const stopReason = workflow.result?.reason ? ` | stop: ${workflow.result.reason}` : "";
		return [
			`plan | ${workflow.status} | root: ${workflow.rootTaskId ?? "(none)"} | ${progress.succeededSteps}/${progress.totalSteps} tasks | ${this.budgetStatusLine}${stopReason}`,
			this.writerLeaseStatusLine,
			`Plan v${plan.version}: ${plan.status} | Goal: ${plan.goal || "(draft)"}`,
			...plan.steps.map((step, index) => `${index + 1}. ${step.title}`),
		];
	}

	get finalReport(): DeliveryWorkflowFinalReport | undefined {
		const workflow = this.workflow;
		if (!isWorkflowTerminalStatus(workflow.status) || !workflow.result) {
			return undefined;
		}
		return buildDeliveryWorkflowFinalReport({
			workflow,
			tasks: this.tasks,
			attempts: this.tasks.flatMap(({ id }) => this.#controller.listAttempts(id)),
			verifications: this.verifications,
		});
	}

	view(agents: readonly AgentInstance[] = [], jobs: readonly Job[] = []): WorkflowView {
		const workflow = this.workflow;
		const rootTask = this.tasks.find(({ id }) => id === workflow.rootTaskId);
		const reportLines = this.statusLines;
		const reportStatusLine = reportLines[0] ?? `plan | ${workflow.status}`;
		const statusLine = reportStatusLine.includes("Budget:")
			? reportStatusLine
			: `${reportStatusLine} | ${this.budgetStatusLine}`;
		return buildWorkflowView({
			workflow,
			plan: this.currentPlan,
			rootTask,
			tasks: this.tasks,
			attempts: this.attempts,
			verifications: this.verifications,
			agents,
			jobs,
			statusLine,
			reportLines,
			budgetStatus: this.budgetStatusLine,
			schedulingDecisions: this.#lastSchedulingDecisions,
		});
	}

	get taskTreeLines(): readonly string[] {
		return formatTaskTree(this.#workflowId, this.tasks, {
			attempts: this.attempts,
			verifications: this.verifications,
		});
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
		const evaluation = new TaskScheduler({
			maxConcurrency,
			maxConcurrentAgents: budget.maxConcurrentAgents,
			maxConcurrentJobs: budget.maxConcurrentJobs,
		}).evaluate(this.tasks);
		this.#lastSchedulingDecisions = evaluation.decisions;
		return evaluation.dispatches;
	}

	selectSubagentDispatches(maxConcurrency: number, maxConcurrentWriters = 1): readonly TaskDispatch[] {
		const budget = this.workflow.budget;
		const evaluation = new TaskScheduler({
			maxConcurrency,
			maxConcurrentAgents: budget.maxConcurrentAgents,
			maxConcurrentJobs: 0,
			agentExecutorKind: "subagent",
			writerAvailable: maxConcurrentWriters > 1 || !DEFAULT_WRITER_LEASE_REGISTRY.get(this.workflow.request.cwd),
			allowParallelWriters: maxConcurrentWriters > 1,
			maxConcurrentWriters,
		}).evaluate(this.tasks);
		this.#lastSchedulingDecisions = evaluation.decisions;
		return evaluation.dispatches;
	}

	selectJobDispatches(maxConcurrency: number): readonly TaskDispatch[] {
		const budget = this.workflow.budget;
		const evaluation = new TaskScheduler({
			maxConcurrency,
			maxConcurrentAgents: 0,
			maxConcurrentJobs: budget.maxConcurrentJobs,
			writerAvailable: !DEFAULT_WRITER_LEASE_REGISTRY.get(this.workflow.request.cwd),
		}).evaluate(this.tasks);
		this.#lastSchedulingDecisions = evaluation.decisions;
		return evaluation.dispatches.filter(({ executorKind }) => executorKind === "job");
	}

	async startJobTask(runtime: JobRuntime, taskId: string): Promise<JobTaskExecution> {
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
		if (task.kind !== "command" || !task.command) {
			throw new Error(`Task ${task.id} is not a Command Task`);
		}
		if (runtime.availableSlots === 0) {
			throw new Error("Job Runtime has no available execution slots");
		}
		const attemptId = `attempt-${randomUUID()}`;
		const job = runtime.queue({
			workflowId: workflow.id,
			taskId: task.id,
			attemptId,
			command: task.command,
			cwd: workflow.request.cwd,
			timeoutMs: task.budget.maxDurationMs,
		});
		const writerLease =
			task.accessMode === "writer"
				? DEFAULT_WRITER_LEASE_REGISTRY.acquire({
						workspace: workflow.request.cwd,
						workflowId: workflow.id,
						taskId: task.id,
						attemptId,
						ttlMs: Math.max(task.budget.maxDurationMs ?? 10 * 60_000, 1_000),
					})
				: undefined;
		try {
			this.#controller.prepareTaskAttempt({
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId: task.id,
				attemptId,
				assignment: {
					executorKind: "job",
					jobId: job.id,
				},
				writerLeaseId: writerLease?.id,
			});
			this.#controller.handleRuntimeEvent({
				type: "attempt_started",
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId: task.id,
				attemptId,
			});
			const completion = runtime
				.start(job.id)
				.then((result) => this.#finishJobTask(task.id, attemptId, result))
				.finally(() => {
					if (writerLease) {
						DEFAULT_WRITER_LEASE_REGISTRY.release(writerLease.id);
					}
					this.#checkpoint();
				});
			return { job: runtime.registry.get(job.id) ?? job, completion };
		} catch (error) {
			if (writerLease) {
				DEFAULT_WRITER_LEASE_REGISTRY.release(writerLease.id);
			}
			await runtime.kill(job.id, "Task dispatch failed").catch(() => undefined);
			throw error;
		}
	}

	async startReadyJobs(runtime: JobRuntime, maxConcurrency: number): Promise<readonly JobTaskExecution[]> {
		this.refreshTaskReadiness();
		const available = Math.min(maxConcurrency, runtime.availableSlots);
		if (available < 1) {
			return [];
		}
		const dispatches = this.selectJobDispatches(available);
		return Promise.all(dispatches.map(({ taskId }) => this.startJobTask(runtime, taskId)));
	}

	async startSubagentTask(
		runtime: SubagentService,
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
		const recommendedProfileRole =
			task.recommendedAgentRole === "coordinator"
				? "planner"
				: task.recommendedAgentRole === "repair"
					? "worker"
					: task.recommendedAgentRole;
		const profileRole =
			input.profileRole ?? recommendedProfileRole ?? (task.accessMode === "writer" ? "worker" : "explorer");
		const profile = input.profile ?? BUILTIN_AGENT_PROFILES[profileRole];
		if (task.accessMode === "writer" && profile.role !== "worker") {
			throw new Error(`Writer Task ${task.id} requires a worker Agent Profile`);
		}
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
		const verificationCommands =
			profile.role === "worker"
				? workerVerificationCommands(task, this.tasks)
				: task.verificationRequirements.flatMap(({ command }) => (command ? [command] : []));
		const taskAttempts = this.#controller.listAttempts(task.id);
		const previousAttempt = taskAttempts.at(-1);
		const attemptsById = new Map(taskAttempts.map((attempt) => [attempt.id, attempt]));
		const recoverySource = input.retryAgentId
			? undefined
			: runtime
					.list(workflow.id)
					.filter(
						(candidate) =>
							candidate.taskId === task.id &&
							candidate.attemptId === task.currentAttemptId &&
							candidate.status === "interrupted" &&
							attemptsById.get(candidate.attemptId)?.status === "interrupted",
					)
					.at(-1);
		const failedSource = input.retryAgentId
			? undefined
			: runtime
					.list(workflow.id)
					.filter(
						(candidate) =>
							candidate.taskId === task.id &&
							candidate.attemptId === previousAttempt?.id &&
							(candidate.status === "failed" || candidate.status === "interrupted") &&
							previousAttempt?.status === "failed",
					)
					.at(-1);
		const sourceAgentId = input.retryAgentId ?? recoverySource?.id ?? failedSource?.id;
		const recoveryReason = recoverySource
			? (recoverySource.lastError ??
				"Recovered after the previous runtime stopped before reporting a terminal state")
			: undefined;
		const failureReason =
			!recoveryReason && previousAttempt?.failure
				? `${previousAttempt.failure.code}: ${previousAttempt.failure.message}`
				: undefined;
		const modelEscalationReason = retryEscalationReason(task, previousAttempt);
		const attemptBudget = taskAttemptBudget(workflow, task, taskAttempts.length);
		const workflowDeadlineAtMs =
			workflow.budget.maxDurationMs === undefined
				? undefined
				: Date.parse(workflow.createdAt) + workflow.budget.maxDurationMs;
		const dependencyArtifactIds = runtime
			.list(workflow.id)
			.filter(
				(candidate) => task.dependencyIds.includes(candidate.taskId) && candidate.artifact?.status === "integrated",
			)
			.flatMap(({ artifact }) => (artifact ? [artifact.id] : []));
		const agent = sourceAgentId
			? await runtime.retry(sourceAgentId, {
					attemptId,
					autoStart: false,
					recoveryReason,
					failureReason,
					modelEscalationReason,
					taskBudget: attemptBudget,
				})
			: await runtime.spawn({
					workflowId: workflow.id,
					taskId: task.id,
					attemptId,
					cwd: workflow.request.cwd,
					profile,
					profileSource: input.profileSource ?? (input.profile ? "runtime" : "builtin"),
					profileSourcePath: input.profileSourcePath,
					scope: "task",
					creationReasonCode:
						task.kind === "repair"
							? "agent.repair_task_ready"
							: task.accessMode === "writer"
								? "agent.writer_task_ready"
								: "agent.read_only_task_ready",
					parentAgentId: input.parentAgentId,
					dependencyArtifactIds,
					parentPermission: input.parentPermission ?? FULL_PERMISSION_SET,
					workflowPermission: input.workflowPermission ?? FULL_PERMISSION_SET,
					taskPermission,
					parentBudget: workflow.budget,
					workflowBudget: workflow.budget,
					taskBudget: attemptBudget,
					workflowDeadlineAtMs,
					riskLevel: workflow.modeDecision?.riskLevel,
					modelEscalationReason,
					verificationCommands,
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
				recoveryOfAttemptId: recoverySource?.attemptId,
				recoveryReason,
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
				const handoff = handoffId ? runtime.getHandoff(handoffId) : undefined;
				return handoff ? [handoff] : [];
			});
			const promptLines =
				profile.role === "worker"
					? [...workerPromptLines(this.currentPlan, task, agent, verificationCommands)]
					: [
							`Workflow: ${workflow.id}`,
							`Approved Plan: ${JSON.stringify(this.currentPlan)}`,
							`Task: ${task.id} | ${task.title}`,
							task.description,
							`Access mode: ${task.accessMode}`,
							`Verification requirements: ${task.verificationRequirements.map(({ description }) => description).join("; ")}`,
						];
			if (previousAttempt?.failure) {
				const diagnostic = `${previousAttempt.failure.code}: ${previousAttempt.failure.message}`.slice(
					0,
					16 * 1024,
				);
				if (profile.role === "worker") {
					promptLines.push(`Previous attempt failure: ${diagnostic}`);
				} else {
					promptLines.push(
						STRUCTURED_HANDOFF_RETRY_INSTRUCTION,
						"Continue as a repair pass. Preserve the previous implementation, inspect its diff and diagnostics, and modify only what remains incorrect. Do not restart repository exploration from scratch.",
						`Previous attempt failure: ${diagnostic}`,
						`Unfinished acceptance criteria: ${task.verificationRequirements.map(({ description }) => description).join("; ")}`,
					);
				}
			}
			if (agent.recoveryContext && profile.role !== "worker") {
				promptLines.push(
					`Recovery context (stable persisted facts; revalidate before relying on them): ${JSON.stringify(agent.recoveryContext)}`,
				);
			}
			if (dependencyHandoffs.length > 0) {
				promptLines.push(`Dependency Handoff: ${JSON.stringify(aggregateHandoffs(dependencyHandoffs))}`);
			}
			await runtime.send(agent.id, promptLines.join("\n"));
		} catch (error) {
			await runtime.interrupt(agent.id, "Task dispatch failed").catch(() => undefined);
			throw error;
		}
		const completion = runtime
			.wait(agent.id)
			.then((result) => this.#finishSubagentTask(task.id, attemptId, result))
			.finally(async () => {
				await runtime.release(agent.id);
				this.#checkpoint();
			});
		return { agent: runtime.get(agent.id) ?? agent, completion };
	}

	async startReadySubagents(
		runtime: SubagentService,
		maxConcurrency: number,
	): Promise<readonly SubagentTaskExecution[]> {
		this.refreshTaskReadiness();
		const dispatches = this.selectSubagentDispatches(maxConcurrency, runtime.parallelWriterCapacity());
		return Promise.all(dispatches.map(({ taskId }) => this.startSubagentTask(runtime, taskId)));
	}

	async startReadyTasks(
		subagentRuntime: SubagentService,
		jobRuntime: JobRuntime,
		maxConcurrency: number,
	): Promise<readonly WorkflowTaskExecution[]> {
		this.refreshTaskReadiness();
		const budget = this.workflow.budget;
		const evaluation = new TaskScheduler({
			maxConcurrency,
			maxConcurrentAgents: Math.min(
				budget.maxConcurrentAgents ?? maxConcurrency,
				subagentRuntime.availableSlots(this.#workflowId),
			),
			maxConcurrentJobs: Math.min(budget.maxConcurrentJobs ?? maxConcurrency, jobRuntime.availableSlots),
			agentExecutorKind: "subagent",
			writerAvailable:
				subagentRuntime.parallelWriterCapacity() > 1 ||
				!DEFAULT_WRITER_LEASE_REGISTRY.get(this.workflow.request.cwd),
			allowParallelWriters: subagentRuntime.parallelWriterCapacity() > 1,
			maxConcurrentWriters: subagentRuntime.parallelWriterCapacity(),
		}).evaluate(this.tasks);
		this.#lastSchedulingDecisions = evaluation.decisions;
		const dispatches = evaluation.dispatches;
		const executions: WorkflowTaskExecution[] = [];
		try {
			for (const dispatch of dispatches) {
				if (dispatch.executorKind === "job") {
					const job = await this.startJobTask(jobRuntime, dispatch.taskId);
					executions.push({
						taskId: dispatch.taskId,
						executorKind: "job",
						resourceId: job.job.id,
						completion: job.completion,
						job,
					});
					continue;
				}
				const subagent = await this.startSubagentTask(subagentRuntime, dispatch.taskId);
				executions.push({
					taskId: dispatch.taskId,
					executorKind: "subagent",
					resourceId: subagent.agent.id,
					completion: subagent.completion,
					subagent,
				});
			}
			return executions;
		} catch (error) {
			await Promise.allSettled(executions.map(({ completion }) => completion));
			throw error;
		}
	}

	taskDetails(taskId: string): readonly string[] {
		const task = this.#controller.getTask(taskId);
		if (!task || task.workflowId !== this.#workflowId) {
			throw new Error(`Task ${taskId} does not exist in workflow ${this.#workflowId}`);
		}
		return formatTaskDetails(
			task,
			this.#controller.listAttempts(task.id),
			this.verifications.filter(({ taskId }) => taskId === task.id),
		);
	}

	createTeamProposalTask(proposal: TeamTaskProposal, admission: { readonly highRiskApproved: boolean }): Task {
		const workflow = this.workflow;
		if (proposal.workflowId !== workflow.id) {
			throw new Error(`Task Proposal ${proposal.id} does not belong to Workflow ${workflow.id}`);
		}
		const existing = this.tasks.find(({ sourceProposalId }) => sourceProposalId === proposal.id);
		if (existing) {
			return existing;
		}
		const taskId = `task-${randomUUID()}`;
		this.#controller.createProposedTask({
			commandId: this.#createId("command"),
			workflowId: workflow.id,
			proposalId: proposal.id,
			taskId,
			sourceAgentId: proposal.sourceAgentId,
			parentTaskId: proposal.sourceTaskId,
			title: proposal.objective,
			description: `${proposal.reason}\n\nRisk: ${proposal.risk}`,
			dependencyIds: proposal.suggestedDependencyIds,
			accessMode: proposal.accessMode,
			requiredAgentRole: proposal.requiredRole,
			riskLevel: proposal.riskLevel,
			highRiskApproved: admission.highRiskApproved,
			verification: proposal.verification,
		});
		this.refreshTaskReadiness();
		const task = this.#controller.getTask(taskId);
		if (!task) {
			throw new Error(`Controller did not create Task ${taskId} for Proposal ${proposal.id}`);
		}
		return task;
	}

	refreshTaskReadiness(): void {
		this.#controller.refreshTaskReadiness({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
		});
		this.#checkpoint();
	}

	retryTask(taskId: string): void {
		this.#controller.retryTask({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId,
		});
		this.#checkpoint();
	}

	cancelTask(taskId: string, reason: string): void {
		this.#controller.cancelTask({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId,
			reason,
		});
		this.#checkpoint();
	}

	async cancel(
		reason = "User cancelled the workflow",
		subagentRuntime?: SubagentService,
		jobRuntime?: JobRuntime,
	): Promise<void> {
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
		await jobRuntime?.cancelWorkflow(this.#workflowId, reason);
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
		this.#checkpoint();
	}

	submit(content: PlanContent): void {
		const plan = this.currentPlan;
		this.#controller.submitPlanForApproval({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			planId: plan.id,
			content: withAgentHandoffVerifications(content),
			plannerReadOnly: true,
		});
		this.#checkpoint();
	}

	approve(comment = "Approved by user"): void {
		const plan = this.currentPlan;
		this.#controller.approvePlan({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			planId: plan.id,
			comment,
		});
		this.refreshTaskReadiness();
	}

	reject(comment: string): void {
		const plan = this.currentPlan;
		this.#controller.rejectPlan({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			planId: plan.id,
			comment,
		});
		this.#checkpoint();
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
		this.#checkpoint();
	}

	beginVerification(): void {
		this.#controller.beginDeliveryVerification({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
		});
		this.#checkpoint();
	}

	recordVerification(input: {
		readonly verificationId: string;
		readonly requirementId: string;
		readonly actor?: {
			readonly kind: "controller" | "agent" | "job";
			readonly id?: string;
		};
		readonly status: Extract<VerificationResult["status"], "passed" | "failed" | "skipped">;
		readonly deliveryFingerprint?: string;
		readonly summary: string;
		readonly evidenceRefs?: readonly string[];
		readonly command?: string;
		readonly exitCode?: number;
		readonly skipReason?: string;
	}): void {
		this.#controller.recordDeliveryVerification({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			...input,
		});
		this.#checkpoint();
	}

	createRepair(failedVerificationId: string): Task {
		const taskId = `task-${randomUUID()}`;
		this.#controller.createRepairTask({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId,
			failedVerificationId,
		});
		this.#checkpoint();
		const task = this.#controller.getTask(taskId);
		if (!task) {
			throw new Error(`Repair Task ${taskId} was not created`);
		}
		return task;
	}

	completeDelivery(input: {
		readonly summary: string;
		readonly risks: readonly string[];
		readonly unfinishedItems: readonly string[];
		readonly deliveryFingerprint?: string;
	}): void {
		this.#controller.completeDelivery({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			...input,
			deliveryFingerprint: input.deliveryFingerprint ?? this.deliveryFingerprint,
		});
		this.#checkpoint();
	}

	failDelivery(reason: string): void {
		const workflow = this.workflow;
		if (workflow.status === "cancelling" || workflow.status === "cancelled") {
			return;
		}
		const rootTaskId = workflow.rootTaskId;
		if (!rootTaskId) {
			throw new Error(`Workflow ${workflow.id} has no root Task`);
		}
		const usage = sumResourceUsage(
			this.tasks
				.flatMap(({ id }) => this.#controller.listAttempts(id))
				.map(({ usage: attemptUsage }) => attemptUsage),
		);
		this.#controller.fail({
			commandId: this.#createId("command"),
			workflowId: this.#workflowId,
			taskId: rootTaskId,
			reason,
			usage,
			durationMs: Math.max(0, Date.now() - Date.parse(workflow.createdAt)),
			runtimeResourcesStopped: true,
		});
		this.#checkpoint();
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
			const requirement = task.verificationRequirements.find(({ required, command }) => required && !command);
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
				changedFiles: [
					...new Set([...result.modifications.map(({ path }) => path), ...result.handoff.changedFiles]),
				],
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
				code: result.errorCode ?? (result.status === "interrupted" ? "subagent.interrupted" : "subagent.failed"),
				message: result.error ?? `Subagent ${result.agentId} failed`,
			},
		});
		return result;
	}

	#checkpoint(): WorkflowContextCheckpoint {
		const snapshot: WorkflowSnapshot = this.#controller.createSnapshot(this.#workflowId);
		const snapshotEntryId = this.#snapshotStore.append(snapshot);
		return { workflowId: this.#workflowId, snapshotEntryId, snapshot };
	}

	async #finishJobTask(taskId: string, attemptId: string, result: Job): Promise<Job> {
		const workflow = this.workflow;
		if (workflow.status !== "executing") {
			return result;
		}
		const task = this.#controller.getTask(taskId);
		if (!task || task.currentAttemptId !== attemptId || task.status !== "running") {
			return result;
		}
		const durationMs =
			result.startedAt && result.endedAt
				? Math.max(0, Date.parse(result.endedAt) - Date.parse(result.startedAt))
				: 0;
		const usage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0,
			turns: 0,
			durationMs,
		};
		if (result.status === "succeeded") {
			const requirement = task.verificationRequirements.find(({ required }) => required);
			if (!requirement) {
				throw new Error(`Task ${task.id} has no required verification`);
			}
			const verificationId = `verification-${randomUUID()}`;
			const evidenceRefs = [result.stdoutRef, result.stderrRef];
			const summary = `Command completed with exit code ${result.exitCode ?? 0}`;
			this.#controller.handleRuntimeEvent({
				type: "attempt_succeeded",
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId,
				attemptId,
				verificationId,
				requirementId: requirement.id,
				usage,
				summary,
				evidenceRefs,
			});
			this.#controller.completeTask({
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId,
				verificationId,
				summary,
				changedFiles: [],
				evidenceRefs,
			});
			this.refreshTaskReadiness();
			return result;
		}
		const attempts = this.#controller.listAttempts(task.id);
		const maximumRetries = task.budget.maxRetries ?? 0;
		const willRetry = attempts.length - 1 < maximumRetries;
		if (result.status === "timed_out") {
			this.#controller.handleRuntimeEvent({
				type: "attempt_timed_out",
				commandId: this.#createId("command"),
				workflowId: workflow.id,
				taskId,
				attemptId,
				usage,
				willRetry,
				timeoutMs: result.timeoutMs,
			});
			return result;
		}
		this.#controller.handleRuntimeEvent({
			type: "attempt_failed",
			commandId: this.#createId("command"),
			workflowId: workflow.id,
			taskId,
			attemptId,
			usage,
			willRetry,
			failure: {
				code: `job_${result.status}`,
				message: result.reason ?? `Job ${result.id} ${result.status}`,
			},
		});
		return result;
	}
}
