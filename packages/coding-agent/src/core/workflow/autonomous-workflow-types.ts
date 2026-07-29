import type { DecisionReasonCode } from "./decision-reasons.ts";
import type { ExecutionMode, WorkflowStatus } from "./types.ts";

export const WORKFLOW_AUTOMATION_WAIT_REASONS = [
	"automation_disabled",
	"awaiting_clarification",
	"awaiting_approval",
	"planning",
	"active_resources",
	"no_capacity",
	"writer_unavailable",
	"blocked_tasks",
	"verification_disabled",
	"cancelling",
	"terminal",
] as const;

export type WorkflowAutomationWaitReason = (typeof WORKFLOW_AUTOMATION_WAIT_REASONS)[number];

export interface WorkflowAutomationPolicy {
	readonly enabled: boolean;
	readonly mode: ExecutionMode;
	readonly autoSchedule: boolean;
	readonly autoVerify: boolean;
	readonly autoRepair: boolean;
	readonly maxConcurrency: number;
}

export type WorkflowAutomationAction =
	| {
			readonly kind: "dispatch";
			readonly taskId: string;
			readonly executorKind: "subagent" | "job";
			readonly resourceId: string;
			readonly reasonCode: DecisionReasonCode;
	  }
	| {
			readonly kind: "verification";
			readonly deliveryFingerprint: string;
			readonly reasonCode: DecisionReasonCode;
	  }
	| {
			readonly kind: "repair";
			readonly taskId: string;
			readonly reasonCode: DecisionReasonCode;
	  };

export interface WorkflowAutomationResult {
	readonly workflowId: string;
	readonly status: WorkflowStatus;
	readonly terminal: boolean;
	readonly waitingReason?: WorkflowAutomationWaitReason;
	readonly actions: readonly WorkflowAutomationAction[];
	readonly decisionReasonCodes: readonly DecisionReasonCode[];
}

export type AutonomousWorkflowEvent =
	| {
			readonly type: "workflow_dispatch_started";
			readonly workflowId: string;
			readonly taskId: string;
			readonly executorKind: "subagent" | "job";
			readonly resourceId: string;
			readonly reasonCode: DecisionReasonCode;
	  }
	| {
			readonly type: "workflow_dispatch_settled";
			readonly workflowId: string;
			readonly taskId: string;
			readonly executorKind: "subagent" | "job";
			readonly resourceId: string;
			readonly succeeded: boolean;
	  }
	| {
			readonly type: "workflow_verification_started";
			readonly workflowId: string;
			readonly deliveryFingerprint: string;
			readonly reasonCode: DecisionReasonCode;
	  }
	| {
			readonly type: "workflow_repair_created";
			readonly workflowId: string;
			readonly taskId: string;
			readonly reasonCode: DecisionReasonCode;
	  }
	| {
			readonly type: "workflow_automation_waiting";
			readonly workflowId: string;
			readonly reason: WorkflowAutomationWaitReason;
			readonly status: WorkflowStatus;
			readonly reasonCode: DecisionReasonCode;
	  };
