import type { Job } from "../jobs/types.ts";
import type { AgentInstance } from "../subagents/types.ts";
import type { Attempt, Plan, Task, VerificationResult, Workflow } from "./types.ts";
import { WORKFLOW_SCHEMA_VERSION } from "./types.ts";

export const WORKFLOW_VIEW_ACTIONS = [
	"approve",
	"reject",
	"replan",
	"dispatch_agents",
	"dispatch_jobs",
	"verify",
	"retry",
	"cancel",
	"resume",
] as const;

export type WorkflowViewAction = (typeof WORKFLOW_VIEW_ACTIONS)[number];

export interface WorkflowView {
	readonly schemaVersion: number;
	readonly workflow: Workflow;
	readonly plan?: Plan;
	readonly rootTask?: Task;
	readonly tasks: readonly Task[];
	readonly attempts: readonly Attempt[];
	readonly verifications: readonly VerificationResult[];
	readonly agents: readonly AgentInstance[];
	readonly jobs: readonly Job[];
	readonly statusLine: string;
	readonly reportLines: readonly string[];
	readonly budgetStatus: string;
	readonly availableActions: readonly WorkflowViewAction[];
	readonly stopReason?: string;
}

export function deriveWorkflowViewActions(workflow: Workflow, tasks: readonly Task[]): readonly WorkflowViewAction[] {
	switch (workflow.status) {
		case "awaiting_approval":
			return ["approve", "reject", "replan", "cancel"];
		case "executing": {
			const actions: WorkflowViewAction[] = ["cancel"];
			if (tasks.some(({ kind, status }) => kind !== "command" && kind !== "control" && status === "ready")) {
				actions.unshift("dispatch_agents");
			}
			if (tasks.some(({ kind, status }) => kind === "command" && status === "ready")) {
				actions.unshift("dispatch_jobs");
			}
			if (
				tasks.some(({ kind }) => kind !== "control") &&
				tasks.filter(({ kind }) => kind !== "control").every(({ status }) => status === "succeeded")
			) {
				actions.unshift("verify");
			}
			if (tasks.some(({ status }) => status === "failed" || status === "cancelled")) {
				actions.unshift("retry");
			}
			return actions;
		}
		case "verifying":
			return ["verify", "cancel"];
		case "blocked":
			return ["retry", "cancel"];
		case "completed":
		case "failed":
		case "cancelled":
			return ["resume"];
		default:
			return ["cancel"];
	}
}

export function buildWorkflowView(
	input: Omit<WorkflowView, "schemaVersion" | "availableActions" | "stopReason">,
): WorkflowView {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		...structuredClone(input),
		availableActions: deriveWorkflowViewActions(input.workflow, input.tasks),
		stopReason: input.workflow.result?.reason,
	};
}
