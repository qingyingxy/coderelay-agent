export const WORKFLOW_SCHEMA_VERSION = 1;

export type WorkflowId = string;
export type PlanId = string;
export type PlanStepId = string;
export type TaskId = string;
export type AttemptId = string;
export type AgentId = string;
export type JobId = string;
export type HandoffId = string;
export type VerificationId = string;
export type EventId = string;
export type EventBatchId = string;
export type CommandId = string;
export type CorrelationId = string;
export type IsoDateTime = string;

export type ExecutionMode = "auto" | "direct" | "plan";
export type ResolvedExecutionMode = Exclude<ExecutionMode, "auto">;
export type ModeDecisionSource = "user" | "forced_policy" | "agent" | "default";
export type RiskLevel = "low" | "medium" | "high";

export type WorkflowStatus =
	| "received"
	| "clarifying"
	| "planning"
	| "awaiting_approval"
	| "executing"
	| "verifying"
	| "blocked"
	| "cancelling"
	| "completed"
	| "failed"
	| "cancelled";

export type WorkflowTerminalStatus = Extract<WorkflowStatus, "completed" | "failed" | "cancelled">;

export type TaskStatus =
	| "pending"
	| "ready"
	| "running"
	| "verifying"
	| "blocked"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "skipped";

export type TaskTerminalStatus = Extract<TaskStatus, "succeeded" | "failed" | "cancelled" | "skipped">;

export type AttemptStatus =
	| "queued"
	| "running"
	| "waiting"
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "interrupted";

export type AttemptTerminalStatus = Extract<
	AttemptStatus,
	"succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted"
>;

export type VerificationStatus = "not_started" | "running" | "passed" | "failed" | "skipped";
export type TaskKind = "agent" | "command" | "control" | "repair";
export type ExecutorKind = "main_agent" | "subagent" | "job";

export interface EntityMetadata {
	readonly schemaVersion: number;
	readonly revision: number;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
}

export interface UserRequest {
	readonly text: string;
	readonly cwd: string;
	readonly requestedMode?: ResolvedExecutionMode;
	readonly attachments: readonly string[];
}

export interface ModeDecision {
	readonly mode: ResolvedExecutionMode;
	readonly source: ModeDecisionSource;
	readonly reason: string;
	readonly riskLevel: RiskLevel;
	readonly decidedAt: IsoDateTime;
}

export interface BudgetLimit {
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly maxCost?: number;
	readonly maxTurns?: number;
	readonly maxDurationMs?: number;
	readonly maxConcurrentAgents?: number;
	readonly maxConcurrentJobs?: number;
	readonly maxAgentDepth?: number;
	readonly maxRetries?: number;
}

export interface ResourceUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly cost: number;
	readonly turns: number;
	readonly durationMs: number;
}

export type WorkflowBlockedResumeStatus = Extract<WorkflowStatus, "planning" | "executing" | "verifying">;
export type TaskBlockedResumeStatus = Extract<TaskStatus, "pending" | "ready" | "running" | "verifying">;

export type BlockedReasonCode =
	| "awaiting_input"
	| "dependency_failed"
	| "permission_required"
	| "budget_exhausted"
	| "writer_unavailable"
	| "external_resource";

export interface BlockedReason<TResumeStatus extends string> {
	readonly code: BlockedReasonCode;
	readonly message: string;
	readonly since: IsoDateTime;
	readonly resumeStatus: TResumeStatus;
}

export type WorkflowBlockedReason = BlockedReason<WorkflowBlockedResumeStatus>;
export type TaskBlockedReason = BlockedReason<TaskBlockedResumeStatus>;

export interface FailureRecord {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: unknown;
}

export type VerificationKind = "diff" | "review" | "test" | "build" | "manual";

export interface VerificationRequirement {
	readonly id: string;
	readonly kind: VerificationKind;
	readonly description: string;
	readonly required: boolean;
	readonly command?: string;
}

export interface VerificationResult {
	readonly id: VerificationId;
	readonly workflowId: WorkflowId;
	readonly taskId?: TaskId;
	readonly requirementId: string;
	readonly status: VerificationStatus;
	readonly command?: string;
	readonly exitCode?: number;
	readonly summary: string;
	readonly evidenceRefs: readonly string[];
	readonly skipReason?: string;
	readonly startedAt?: IsoDateTime;
	readonly endedAt?: IsoDateTime;
}

export interface TaskAssignment {
	readonly executorKind: ExecutorKind;
	readonly agentProfile?: string;
	readonly agentId?: AgentId;
	readonly jobId?: JobId;
}

export interface TaskResult {
	readonly summary: string;
	readonly changedFiles: readonly string[];
	readonly verificationIds: readonly VerificationId[];
	readonly handoffId?: HandoffId;
	readonly completedAt: IsoDateTime;
}

export interface Task extends EntityMetadata {
	readonly id: TaskId;
	readonly workflowId: WorkflowId;
	readonly parentTaskId?: TaskId;
	readonly sourcePlanId?: PlanId;
	readonly sourcePlanStepId?: PlanStepId;
	readonly kind: TaskKind;
	readonly title: string;
	readonly description: string;
	readonly status: TaskStatus;
	readonly dependencyIds: readonly TaskId[];
	readonly assignment?: TaskAssignment;
	readonly budget: BudgetLimit;
	readonly usage: ResourceUsage;
	readonly attemptIds: readonly AttemptId[];
	readonly currentAttemptId?: AttemptId;
	readonly verificationRequirements: readonly VerificationRequirement[];
	readonly blockedReason?: TaskBlockedReason;
	readonly result?: TaskResult;
}

export interface Attempt extends EntityMetadata {
	readonly id: AttemptId;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly number: number;
	readonly status: AttemptStatus;
	readonly executorKind: ExecutorKind;
	readonly agentId?: AgentId;
	readonly jobId?: JobId;
	readonly startedAt?: IsoDateTime;
	readonly endedAt?: IsoDateTime;
	readonly usage: ResourceUsage;
	readonly failure?: FailureRecord;
}

export interface WorkflowResult {
	readonly status: WorkflowTerminalStatus;
	readonly summary: string;
	readonly completedTaskIds: readonly TaskId[];
	readonly failedTaskIds: readonly TaskId[];
	readonly changedFiles: readonly string[];
	readonly verificationIds: readonly VerificationId[];
	readonly risks: readonly string[];
	readonly unfinishedItems: readonly string[];
	readonly usage: ResourceUsage;
	readonly durationMs: number;
	readonly reason?: string;
}

export interface Workflow extends EntityMetadata {
	readonly id: WorkflowId;
	readonly status: WorkflowStatus;
	readonly request: UserRequest;
	readonly modeDecision?: ModeDecision;
	readonly currentPlanId?: PlanId;
	readonly rootTaskId?: TaskId;
	readonly budget: BudgetLimit;
	readonly usage: ResourceUsage;
	readonly blockedReason?: WorkflowBlockedReason;
	readonly result?: WorkflowResult;
}
