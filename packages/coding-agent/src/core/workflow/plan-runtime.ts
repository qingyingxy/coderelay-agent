import { randomUUID } from "node:crypto";
import type { SessionManager } from "../session-manager.ts";
import { WorkflowController, type WorkflowControllerOptions } from "./controller.ts";
import { SessionWorkflowEventLog } from "./event-log.ts";
import { derivePlanProgress } from "./plan-progress.ts";
import { WorkflowStore } from "./stores.ts";
import { isWorkflowTerminalStatus } from "./transitions.ts";
import type { Plan, PlanContent, PlanProgress, Task, UserRequest, Workflow } from "./types.ts";

export interface StartPlanRuntimeInput {
	readonly request: UserRequest;
	readonly workflowId?: string;
	readonly rootTaskId?: string;
	readonly planId?: string;
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
			`Goal: ${plan.goal || "(draft)"}`,
			...plan.steps.map((step, index) => `${index + 1}. ${step.title}`),
		];
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
}
