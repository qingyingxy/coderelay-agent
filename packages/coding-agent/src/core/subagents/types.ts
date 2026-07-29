import type { AgentProfile } from "../workflow/agent-profile.ts";
import type { PermissionSet } from "../workflow/runtime-policy.ts";
import type {
	AgentId,
	AttemptId,
	BudgetLimit,
	HandoffId,
	IsoDateTime,
	ResourceUsage,
	TaskId,
	WorkflowId,
} from "../workflow/types.ts";
import type { AgentEnforcementPlan, SandboxVerification } from "./enforcement-plan.ts";

export const AGENT_INSTANCE_STATUSES = [
	"starting",
	"idle",
	"running",
	"waiting",
	"stopping",
	"stopped",
	"failed",
	"interrupted",
] as const;
export type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];

export const AGENT_SCOPES = ["delegation", "task", "workflow"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const AGENT_BACKENDS = ["rpc", "in-process"] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];
export type AgentBackendPolicy = AgentBackend | "auto";

export interface AgentWorkspace {
	readonly id: string;
	readonly path: string;
	readonly kind?: "current" | "git-worktree";
	readonly repositoryIdentity?: string;
	readonly repositoryRoot?: string;
	readonly baselineCommit?: string;
	readonly resultBranch?: string;
	readonly baselineFingerprint?: string;
	readonly assurance?: "shared" | "isolated";
}

export type WorkspaceArtifactStatus = "created" | "integrated" | "failed";

export interface WorkspaceArtifact {
	readonly id: string;
	readonly workspaceId: string;
	readonly repositoryIdentity: string;
	readonly baselineCommit: string;
	readonly resultCommit: string;
	readonly patchPath: string;
	readonly patchDigest?: string;
	readonly changedFiles: readonly string[];
	readonly status: WorkspaceArtifactStatus;
	readonly createdAt: IsoDateTime;
	readonly integratedAt?: IsoDateTime;
	readonly error?: string;
}

export interface WorkspaceRecoveryVerification {
	readonly status: "available" | "artifact-only" | "unavailable" | "invalid";
	readonly checkedAt: IsoDateTime;
	readonly details: readonly string[];
}

export interface AgentRecoveryContext {
	readonly sourceAgentId: AgentId;
	readonly sourceAttemptId: AttemptId;
	readonly reason: string;
	readonly checkpointAt: IsoDateTime;
	readonly lastPrompt?: string;
	readonly lastAssistantText?: string;
	readonly handoff?: Handoff;
	readonly artifact?: WorkspaceArtifact;
	readonly artifactPatch?: string;
	readonly workspace: WorkspaceRecoveryVerification;
}

export interface AgentInstance {
	readonly id: AgentId;
	readonly workflowId: WorkflowId;
	readonly parentAgentId?: AgentId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly profileName: string;
	/** Stable Profile snapshot for persisted Runtime-owned Agents. */
	readonly profile?: AgentProfile;
	readonly profileSource?: "builtin" | "global" | "project" | "runtime";
	readonly profileSourcePath?: string;
	readonly scope: AgentScope;
	readonly backend: AgentBackend;
	readonly backendReason?: string;
	readonly enforcementPlan?: AgentEnforcementPlan;
	readonly sandbox?: SandboxVerification;
	readonly workspace?: AgentWorkspace;
	readonly artifact?: WorkspaceArtifact;
	readonly sessionId?: string;
	readonly sessionReleasedAt?: IsoDateTime;
	readonly status: AgentInstanceStatus;
	readonly depth: number;
	readonly retryCount: number;
	readonly retryOfAgentId?: AgentId;
	readonly recoveryOfAgentId?: AgentId;
	readonly recoveryContext?: AgentRecoveryContext;
	readonly effectivePermissions: PermissionSet;
	readonly budget: BudgetLimit;
	readonly usage: ResourceUsage;
	readonly handoffId?: HandoffId;
	readonly lastError?: string;
	readonly revision: number;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
}

export interface SourceLocation {
	readonly path: string;
	readonly line?: number;
	readonly note?: string;
}

export interface Handoff {
	readonly id: HandoffId;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly agentId: AgentId;
	readonly conclusion: string;
	readonly evidence: readonly SourceLocation[];
	readonly architectureFindings: readonly string[];
	readonly changedFiles: readonly string[];
	readonly verificationSummary: readonly string[];
	readonly risks: readonly string[];
	readonly unfinishedItems: readonly string[];
	readonly createdAt: IsoDateTime;
}

export type HandoffDraft = Omit<Handoff, "id" | "workflowId" | "taskId" | "attemptId" | "agentId" | "createdAt">;

export interface AggregatedHandoff {
	readonly handoffIds: readonly HandoffId[];
	readonly conclusions: readonly string[];
	readonly evidence: readonly SourceLocation[];
	readonly architectureFindings: readonly string[];
	readonly changedFiles: readonly string[];
	readonly verificationSummary: readonly string[];
	readonly risks: readonly string[];
	readonly unfinishedItems: readonly string[];
	readonly modificationConflicts: readonly {
		readonly path: string;
		readonly agentIds: readonly AgentId[];
	}[];
}

export interface SubagentModification {
	readonly path: string;
	readonly operation: "edit" | "write";
	readonly toolCallId: string;
}

export type AgentRunStatus = "completed" | "failed" | "interrupted";

export interface AgentRunResult {
	readonly agentId: AgentId;
	readonly status: AgentRunStatus;
	readonly handoff?: Handoff;
	readonly usage: ResourceUsage;
	readonly modifications: readonly SubagentModification[];
	readonly artifact?: WorkspaceArtifact;
	readonly error?: string;
}

export type AgentRuntimeEventType =
	| "created"
	| "ready"
	| "started"
	| "progress"
	| "usage"
	| "waiting"
	| "blocked"
	| "stopping"
	| "completed"
	| "failed"
	| "interrupted"
	| "stopped"
	| "steered"
	| "resumed"
	| "session_released";

export type StableSubagentEventName =
	| "subagent_created"
	| "subagent_queued"
	| "subagent_started"
	| "subagent_progress"
	| "subagent_waiting"
	| "subagent_steered"
	| "subagent_usage"
	| "subagent_completed"
	| "subagent_failed"
	| "subagent_interrupted"
	| "subagent_resumed"
	| "subagent_session_released";

export interface AgentRuntimeEvent {
	readonly sequence: number;
	readonly agentId: AgentId;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly type: AgentRuntimeEventType;
	readonly eventName: StableSubagentEventName;
	readonly occurredAt: IsoDateTime;
	readonly message?: string;
}

export type AgentTranscriptEntryType = "prompt" | "steer" | "assistant" | "activity" | "interrupt" | "resume";

export interface AgentTranscriptEntry {
	readonly sequence: number;
	readonly agentId: AgentId;
	readonly type: AgentTranscriptEntryType;
	readonly text: string;
	readonly occurredAt: IsoDateTime;
}

export interface AgentTranscriptView {
	readonly agentId: AgentId;
	readonly sessionId?: string;
	readonly backend: AgentBackend;
	readonly released: boolean;
	readonly entries: readonly AgentTranscriptEntry[];
}

export interface SpawnSubagentInput {
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly cwd: string;
	readonly profile: AgentProfile;
	readonly profileSource?: "builtin" | "global" | "project" | "runtime";
	readonly profileSourcePath?: string;
	/** Governance scope. Existing Workflow dispatches default to `task`. */
	readonly scope?: AgentScope;
	/** Requested Session backend policy. `auto` remains safety-first and falls back to RPC. */
	readonly backend?: AgentBackendPolicy;
	readonly parentAgentId?: AgentId;
	readonly parentPermission: PermissionSet;
	readonly workflowPermission: PermissionSet;
	readonly taskPermission: PermissionSet;
	readonly parentBudget: BudgetLimit;
	readonly workflowBudget: BudgetLimit;
	readonly taskBudget: BudgetLimit;
	readonly retryCount?: number;
	readonly retryOfAgentId?: AgentId;
	readonly recoveryOfAgentId?: AgentId;
	readonly recoveryContext?: AgentRecoveryContext;
}

export interface RetrySubagentInput {
	readonly attemptId: AttemptId;
	readonly autoStart?: boolean;
	readonly recoveryReason?: string;
}

export interface SubagentSessionConfig {
	readonly cwd: string;
	readonly profile: AgentProfile;
	readonly modelName?: string;
	readonly toolNames: readonly string[];
	readonly effectivePermissions: PermissionSet;
	readonly budget: BudgetLimit;
	readonly enforcementPlan?: AgentEnforcementPlan;
	readonly sandbox?: SandboxVerification;
	readonly environment?: Readonly<Record<string, string>>;
}

export interface SubagentSession {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(timeoutMs: number): Promise<void>;
	getSessionId(): Promise<string>;
	getLastAssistantText(): Promise<string | null>;
	getUsage(): Promise<ResourceUsage>;
	onEvent(listener: (event: unknown) => void): () => void;
}

export interface SubagentSessionFactory {
	create(config: SubagentSessionConfig): SubagentSession;
}
