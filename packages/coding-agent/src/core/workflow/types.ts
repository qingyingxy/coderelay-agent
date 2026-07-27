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

export const EXECUTION_MODES = ["auto", "direct", "plan"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const RESOLVED_EXECUTION_MODES = ["direct", "plan"] as const;
export type ResolvedExecutionMode = (typeof RESOLVED_EXECUTION_MODES)[number];

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "auto";

export function isExecutionMode(value: unknown): value is ExecutionMode {
	return typeof value === "string" && EXECUTION_MODES.some((mode) => mode === value);
}

export function isResolvedExecutionMode(value: unknown): value is ResolvedExecutionMode {
	return typeof value === "string" && RESOLVED_EXECUTION_MODES.some((mode) => mode === value);
}
export type ModeDecisionSource = "user" | "forced_policy" | "agent" | "default";
export type RiskLevel = "low" | "medium" | "high";
export type DirectPlanUpgradeTrigger = "complexity" | "risk" | "confidence";

export interface DirectPlanUpgradeRequest {
	readonly reason: string;
	readonly riskLevel: RiskLevel;
	readonly triggers: readonly DirectPlanUpgradeTrigger[];
	readonly requestedAt: IsoDateTime;
}

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
export type TaskAccessMode = "read_only" | "writer";
export type ExecutorKind = "main_agent" | "subagent" | "job";

export const PLAN_STATUSES = ["draft", "awaiting_approval", "approved", "rejected", "superseded"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

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

export const FILE_INTENT_ACTIONS = ["inspect", "create", "modify", "delete"] as const;
export type FileIntentAction = (typeof FILE_INTENT_ACTIONS)[number];

export interface FileIntent {
	readonly path: string;
	readonly action: FileIntentAction;
	readonly reason: string;
}

export interface PlanRisk {
	readonly level: RiskLevel;
	readonly description: string;
	readonly mitigation: string;
}

export interface PlanStep {
	readonly id: PlanStepId;
	readonly kind?: Extract<TaskKind, "agent" | "command">;
	readonly command?: string;
	readonly title: string;
	readonly description: string;
	readonly dependsOn: readonly PlanStepId[];
	readonly fileIntents: readonly FileIntent[];
	readonly verificationRequirementIds: readonly string[];
}

export interface PlanContent {
	readonly goal: string;
	readonly assumptions: readonly string[];
	readonly steps: readonly PlanStep[];
	readonly risks: readonly PlanRisk[];
	readonly verificationRequirements: readonly VerificationRequirement[];
}

export type PlanDecisionAction = "approved" | "rejected" | "revision_requested";

export interface PlanDecisionRecord {
	readonly action: PlanDecisionAction;
	readonly comment: string;
	readonly decidedAt: IsoDateTime;
}

export interface Plan extends EntityMetadata, PlanContent {
	readonly id: PlanId;
	readonly workflowId: WorkflowId;
	readonly version: number;
	readonly supersedesPlanId?: PlanId;
	readonly status: PlanStatus;
	readonly decisionHistory: readonly PlanDecisionRecord[];
}

export interface PlanProgress {
	readonly planId: PlanId;
	readonly totalSteps: number;
	readonly pendingSteps: number;
	readonly runningSteps: number;
	readonly succeededSteps: number;
	readonly failedSteps: number;
	readonly cancelledSteps: number;
	readonly percentComplete: number;
}

export interface TaskAssignment {
	readonly executorKind: ExecutorKind;
	readonly agentProfile?: string;
	readonly agentId?: AgentId;
	readonly jobId?: JobId;
	readonly agentDepth?: number;
}

export interface TaskResult {
	readonly summary: string;
	readonly changedFiles: readonly string[];
	readonly verificationIds: readonly VerificationId[];
	readonly handoffId?: HandoffId;
	readonly completedAt: IsoDateTime;
}

export interface FileModificationRecord {
	readonly path: string;
	readonly operation: "edit" | "write";
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly agentId: AgentId;
	readonly toolCallId: string;
	readonly recordedAt: IsoDateTime;
}

export interface Task extends EntityMetadata {
	readonly id: TaskId;
	readonly workflowId: WorkflowId;
	readonly parentTaskId?: TaskId;
	readonly sourcePlanId?: PlanId;
	readonly sourcePlanStepId?: PlanStepId;
	readonly kind: TaskKind;
	readonly command?: string;
	readonly accessMode: TaskAccessMode;
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
	readonly modifications: readonly FileModificationRecord[];
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
	readonly directPlanUpgradeRequest?: DirectPlanUpgradeRequest;
	readonly currentPlanId?: PlanId;
	readonly rootTaskId?: TaskId;
	readonly budget: BudgetLimit;
	readonly usage: ResourceUsage;
	readonly blockedReason?: WorkflowBlockedReason;
	readonly result?: WorkflowResult;
}
