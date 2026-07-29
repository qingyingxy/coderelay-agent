import type { DeliveryRuntime } from "../delivery/delivery-runtime.ts";
import type { JobRuntime } from "../jobs/job-runtime.ts";
import type { SubagentService } from "../subagents/subagent-service.ts";
import type {
	AutonomousWorkflowEvent,
	WorkflowAutomationAction,
	WorkflowAutomationPolicy,
	WorkflowAutomationResult,
	WorkflowAutomationWaitReason,
} from "./autonomous-workflow-types.ts";
import type { PlanWorkflowRuntime, WorkflowTaskExecution } from "./plan-runtime.ts";
import { isWorkflowTerminalStatus } from "./transitions.ts";

export interface AutonomousWorkflowRunnerOptions {
	readonly runtime: PlanWorkflowRuntime;
	readonly subagentRuntime: SubagentService;
	readonly jobRuntime: JobRuntime;
	readonly deliveryRuntime: DeliveryRuntime;
	readonly policy: WorkflowAutomationPolicy;
	readonly onEvent?: (event: AutonomousWorkflowEvent) => void;
	readonly onExecution?: (execution: WorkflowTaskExecution) => void;
}

export class AutonomousWorkflowRunner {
	readonly #runtime: PlanWorkflowRuntime;
	readonly #subagentRuntime: SubagentService;
	readonly #jobRuntime: JobRuntime;
	readonly #deliveryRuntime: DeliveryRuntime;
	readonly #policy: WorkflowAutomationPolicy;
	readonly #onEvent?: (event: AutonomousWorkflowEvent) => void;
	readonly #onExecution?: (execution: WorkflowTaskExecution) => void;
	#inFlight?: Promise<WorkflowAutomationResult>;
	#stopped = false;

	constructor(options: AutonomousWorkflowRunnerOptions) {
		this.#runtime = options.runtime;
		this.#subagentRuntime = options.subagentRuntime;
		this.#jobRuntime = options.jobRuntime;
		this.#deliveryRuntime = options.deliveryRuntime;
		this.#policy = options.policy;
		this.#onEvent = options.onEvent;
		this.#onExecution = options.onExecution;
	}

	get isRunning(): boolean {
		return this.#inFlight !== undefined;
	}

	stop(): void {
		this.#stopped = true;
	}

	pump(): Promise<WorkflowAutomationResult> {
		if (!this.#inFlight) {
			this.#stopped = false;
			this.#inFlight = this.#run().finally(() => {
				this.#inFlight = undefined;
			});
		}
		return this.#inFlight;
	}

	async #run(): Promise<WorkflowAutomationResult> {
		const actions: WorkflowAutomationAction[] = [];
		if (!this.#policy.enabled) {
			return this.#waiting("automation_disabled", actions);
		}

		for (;;) {
			const workflow = this.#runtime.workflow;
			if (isWorkflowTerminalStatus(workflow.status)) {
				return this.#waiting("terminal", actions);
			}
			if (this.#stopped) {
				return this.#waiting("automation_disabled", actions);
			}
			if (workflow.status === "cancelling") {
				return this.#waiting("cancelling", actions);
			}
			if (workflow.status === "clarifying") {
				return this.#waiting("awaiting_clarification", actions);
			}
			if (workflow.status === "planning") {
				return this.#waiting("planning", actions);
			}
			if (workflow.status === "awaiting_approval") {
				return this.#waiting("awaiting_approval", actions);
			}
			if (workflow.status === "blocked") {
				return this.#waiting("blocked_tasks", actions);
			}
			if (workflow.status === "verifying") {
				if (!this.#policy.autoVerify) {
					return this.#waiting("verification_disabled", actions);
				}
				const fingerprint = this.#runtime.deliveryFingerprint;
				const reasonCode = "automation.verification_all_tasks_succeeded" as const;
				actions.push({ kind: "verification", deliveryFingerprint: fingerprint, reasonCode });
				this.#onEvent?.({
					type: "workflow_verification_started",
					workflowId: workflow.id,
					deliveryFingerprint: fingerprint,
					reasonCode,
				});
				const delivery = await this.#deliveryRuntime.run(this.#runtime, {
					allowRepair: this.#policy.autoRepair,
				});
				if (delivery.status === "repair_created" && delivery.repairTask) {
					const repairReasonCode = delivery.reasonCode ?? "repair.verification_failed";
					actions.push({ kind: "repair", taskId: delivery.repairTask.id, reasonCode: repairReasonCode });
					this.#onEvent?.({
						type: "workflow_repair_created",
						workflowId: workflow.id,
						taskId: delivery.repairTask.id,
						reasonCode: repairReasonCode,
					});
					continue;
				}
				continue;
			}
			if (workflow.status !== "executing") {
				return this.#waiting("blocked_tasks", actions);
			}

			this.#runtime.refreshTaskReadiness();
			const tasks = this.#runtime.tasks.filter(({ kind }) => kind !== "control");
			if (tasks.some(({ status }) => status === "running" || status === "verifying")) {
				return this.#waiting("active_resources", actions);
			}
			if (tasks.length > 0 && tasks.every(({ status }) => status === "succeeded")) {
				if (!this.#policy.autoVerify) {
					return this.#waiting("verification_disabled", actions);
				}
				this.#runtime.beginVerification();
				continue;
			}
			if (!this.#policy.autoSchedule) {
				return this.#waiting("automation_disabled", actions);
			}

			let executions: readonly WorkflowTaskExecution[];
			try {
				executions = await this.#runtime.startReadyTasks(
					this.#subagentRuntime,
					this.#jobRuntime,
					this.#policy.maxConcurrency,
				);
			} catch (error) {
				this.#runtime.failDelivery(
					`Automatic dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			if (executions.length === 0) {
				const ready = this.#runtime.tasks.filter(({ status, kind }) => status === "ready" && kind !== "control");
				if (
					ready.some(({ accessMode }) => accessMode === "writer") &&
					this.#runtime.writerLeaseStatusLine !== "Writer Lease: available"
				) {
					return this.#waiting("writer_unavailable", actions);
				}
				if (ready.length > 0) {
					return this.#waiting("no_capacity", actions);
				}
				this.#runtime.failDelivery("Workflow has incomplete Tasks but no executable dispatch");
				continue;
			}

			for (const execution of executions) {
				const action: WorkflowAutomationAction = {
					kind: "dispatch",
					taskId: execution.taskId,
					executorKind: execution.executorKind,
					resourceId: execution.resourceId,
					reasonCode: "scheduler.selected",
				};
				actions.push(action);
				this.#onExecution?.(execution);
				this.#onEvent?.({
					type: "workflow_dispatch_started",
					workflowId: workflow.id,
					taskId: execution.taskId,
					executorKind: execution.executorKind,
					resourceId: execution.resourceId,
					reasonCode: action.reasonCode,
				});
			}
			const settled = await Promise.allSettled(executions.map(({ completion }) => completion));
			for (const [index, result] of settled.entries()) {
				const execution = executions[index];
				if (!execution) {
					continue;
				}
				this.#onEvent?.({
					type: "workflow_dispatch_settled",
					workflowId: workflow.id,
					taskId: execution.taskId,
					executorKind: execution.executorKind,
					resourceId: execution.resourceId,
					succeeded: result.status === "fulfilled",
				});
			}
		}
	}

	#waiting(
		reason: WorkflowAutomationWaitReason,
		actions: readonly WorkflowAutomationAction[],
	): WorkflowAutomationResult {
		const workflow = this.#runtime.workflow;
		this.#onEvent?.({
			type: "workflow_automation_waiting",
			workflowId: workflow.id,
			reason,
			status: workflow.status,
			reasonCode: `automation.${reason}`,
		});
		return {
			workflowId: workflow.id,
			status: workflow.status,
			terminal: isWorkflowTerminalStatus(workflow.status),
			waitingReason: reason,
			actions: [...actions],
			decisionReasonCodes: [...actions.map(({ reasonCode }) => reasonCode), `automation.${reason}` as const],
		};
	}
}
