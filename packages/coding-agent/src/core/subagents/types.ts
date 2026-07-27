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

export interface AgentInstance {
	readonly id: AgentId;
	readonly workflowId: WorkflowId;
	readonly parentAgentId?: AgentId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly profileName: string;
	readonly sessionId?: string;
	readonly status: AgentInstanceStatus;
	readonly depth: number;
	readonly retryCount: number;
	readonly retryOfAgentId?: AgentId;
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
	| "stopped";

export interface AgentRuntimeEvent {
	readonly sequence: number;
	readonly agentId: AgentId;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly type: AgentRuntimeEventType;
	readonly occurredAt: IsoDateTime;
	readonly message?: string;
}

export interface SpawnSubagentInput {
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly cwd: string;
	readonly profile: AgentProfile;
	readonly parentAgentId?: AgentId;
	readonly parentPermission: PermissionSet;
	readonly workflowPermission: PermissionSet;
	readonly taskPermission: PermissionSet;
	readonly parentBudget: BudgetLimit;
	readonly workflowBudget: BudgetLimit;
	readonly taskBudget: BudgetLimit;
	readonly retryCount?: number;
	readonly retryOfAgentId?: AgentId;
}

export interface RetrySubagentInput {
	readonly attemptId: AttemptId;
	readonly autoStart?: boolean;
}

export interface SubagentSessionConfig {
	readonly cwd: string;
	readonly profile: AgentProfile;
	readonly toolNames: readonly string[];
	readonly effectivePermissions: PermissionSet;
	readonly budget: BudgetLimit;
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
