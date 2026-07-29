import type {
	AgentId,
	AttemptId,
	IsoDateTime,
	RiskLevel,
	Task,
	TaskAccessMode,
	TaskAgentRole,
	TaskId,
	VerificationKind,
	Workflow,
	WorkflowId,
} from "../workflow/types.ts";
import type { AgentInstance, WorkspaceArtifact } from "./types.ts";

export const TEAM_ROLES = ["coordinator", "explorer", "worker", "reviewer", "repair"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_MESSAGE_TYPES = [
	"information",
	"question",
	"answer",
	"review_finding",
	"task_proposal",
	"handoff_request",
] as const;
export type TeamMessageType = (typeof TEAM_MESSAGE_TYPES)[number];

export interface TeamMessageTarget {
	readonly agentId?: AgentId;
	readonly role?: TeamRole;
}

export interface TeamMessageDraft {
	readonly workflowId: WorkflowId;
	readonly sourceAgentId: AgentId;
	readonly target: TeamMessageTarget;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly type: TeamMessageType;
	readonly body?: string;
	readonly artifactRef?: string;
}

export interface TeamMessage extends TeamMessageDraft {
	readonly id: string;
	readonly sequence: number;
	readonly occurredAt: IsoDateTime;
}

export interface TeamProposalVerification {
	readonly kind: VerificationKind;
	readonly description: string;
	readonly command?: string;
}

export interface TeamTaskProposalDraft {
	readonly workflowId: WorkflowId;
	readonly sourceAgentId: AgentId;
	readonly sourceTaskId: TaskId;
	readonly sourceAttemptId: AttemptId;
	readonly objective: string;
	readonly reason: string;
	readonly suggestedDependencyIds: readonly TaskId[];
	readonly requiredRole: TaskAgentRole;
	readonly accessMode: TaskAccessMode;
	readonly riskLevel: RiskLevel;
	readonly risk: string;
	readonly verification: TeamProposalVerification;
}

export type TeamTaskProposalStatus = "pending" | "approval_required" | "accepted" | "merged" | "rejected";

export interface TeamTaskProposal extends TeamTaskProposalDraft {
	readonly id: string;
	readonly status: TeamTaskProposalStatus;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
	readonly revision: number;
	readonly decisionActor?: "controller" | "scheduler";
	readonly decisionReason?: string;
	readonly resultingTaskId?: TaskId;
	readonly mergedTaskId?: TaskId;
}

export type TeamProposalDecision =
	| {
			readonly action: "accept";
			readonly actor: "controller" | "scheduler";
			readonly reason: string;
			readonly userApprovedHighRisk?: boolean;
	  }
	| {
			readonly action: "merge";
			readonly actor: "controller" | "scheduler";
			readonly reason: string;
			readonly taskId: TaskId;
	  }
	| {
			readonly action: "reject";
			readonly actor: "controller" | "scheduler";
			readonly reason: string;
	  }
	| {
			readonly action: "require_approval";
			readonly actor: "controller" | "scheduler";
			readonly reason: string;
	  };

export type TeamAuditEventType =
	| "message.sent"
	| "proposal.submitted"
	| "proposal.approval_required"
	| "proposal.accepted"
	| "proposal.merged"
	| "proposal.rejected";

export type TeamAuditEvent =
	| {
			readonly sequence: number;
			readonly workflowId: WorkflowId;
			readonly type: "message.sent";
			readonly occurredAt: IsoDateTime;
			readonly message: TeamMessage;
	  }
	| {
			readonly sequence: number;
			readonly workflowId: WorkflowId;
			readonly type: Exclude<TeamAuditEventType, "message.sent">;
			readonly occurredAt: IsoDateTime;
			readonly proposal: TeamTaskProposal;
	  };

export interface TeamMemberView {
	readonly agent: AgentInstance;
	readonly role: TeamRole;
	readonly task: Task;
	readonly artifact?: WorkspaceArtifact;
}

export interface TeamTaskBoardView {
	readonly workflow: Workflow;
	/**
	 * Live Workflow Task Graph projection. The Team Runtime never persists these
	 * Tasks or owns their statuses.
	 */
	readonly tasks: readonly Task[];
}

export interface AgentTeamView {
	readonly workflowId: WorkflowId;
	readonly board: TeamTaskBoardView;
	readonly members: readonly TeamMemberView[];
	readonly messages: readonly TeamMessage[];
	readonly proposals: readonly TeamTaskProposal[];
	readonly events: readonly TeamAuditEvent[];
}
