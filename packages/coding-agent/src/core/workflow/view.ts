import type { Job } from "../jobs/types.ts";
import type { AgentInstance } from "../subagents/types.ts";
import type { WorkflowAutomationWaitReason } from "./autonomous-workflow-types.ts";
import { type DecisionExplanation, resolveModeDecisionReasonCode } from "./decision-reasons.ts";
import type { TaskSchedulingDecision } from "./scheduler.ts";
import type { Attempt, ExecutionMode, Plan, Task, VerificationResult, Workflow } from "./types.ts";
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
	readonly decisions: readonly DecisionExplanation[];
	readonly budgetStatus: string;
	readonly availableActions: readonly WorkflowViewAction[];
	readonly stopReason?: string;
	readonly automation?: {
		readonly enabled: boolean;
		readonly mode: ExecutionMode;
		readonly running: boolean;
		readonly waitingReason?: WorkflowAutomationWaitReason;
	};
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
	input: Omit<WorkflowView, "schemaVersion" | "availableActions" | "stopReason" | "decisions"> & {
		readonly schedulingDecisions?: readonly TaskSchedulingDecision[];
	},
): WorkflowView {
	const { schedulingDecisions = [], ...view } = input;
	const decisions: DecisionExplanation[] = [];
	if (view.workflow.modeDecision) {
		const mode = view.workflow.modeDecision;
		decisions.push({
			category: "mode",
			reasonCode: mode.reasonCode ?? resolveModeDecisionReasonCode(mode.mode, mode.source),
			summary: mode.reason,
			entityId: view.workflow.id,
		});
	}
	for (const agent of view.agents) {
		if (agent.creationReasonCode) {
			decisions.push({
				category: "agent",
				reasonCode: agent.creationReasonCode,
				summary: `Created ${agent.profileName} Agent for Task ${agent.taskId}`,
				entityId: agent.id,
			});
		}
		if (agent.backendReasonCode) {
			decisions.push({
				category: "backend",
				reasonCode: agent.backendReasonCode,
				summary: agent.backendReason ?? `Selected ${agent.backend} Backend`,
				entityId: agent.id,
			});
		}
	}
	for (const task of view.tasks) {
		if (task.repairReasonCode) {
			decisions.push({
				category: "repair",
				reasonCode: task.repairReasonCode,
				summary: `Created Repair Task ${task.id} for Verification ${task.repairForVerificationId}`,
				entityId: task.id,
			});
		}
	}
	for (const decision of schedulingDecisions) {
		decisions.push({
			category: "scheduler",
			reasonCode: decision.reasonCode,
			summary: decision.summary,
			entityId: decision.taskId,
		});
	}
	const decisionLines =
		decisions.length === 0
			? []
			: ["Decision reasons:", ...decisions.map(({ reasonCode, summary }) => `- ${reasonCode}: ${summary}`)];
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		...structuredClone(view),
		reportLines: [...view.reportLines, ...decisionLines],
		decisions,
		availableActions: deriveWorkflowViewActions(view.workflow, view.tasks),
		stopReason: view.workflow.result?.reason,
	};
}
