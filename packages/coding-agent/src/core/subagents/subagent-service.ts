import type { AgentId, HandoffId, WorkflowId } from "../workflow/types.ts";
import type {
	AgentInstance,
	AgentRunResult,
	AgentRuntimeEvent,
	AgentTranscriptView,
	Handoff,
	RetrySubagentInput,
	SpawnSubagentInput,
} from "./types.ts";

/**
 * The single Core boundary for creating, controlling, and observing Subagents.
 *
 * Workflow, CLI, RPC, model tools, and extensions depend on this contract.
 * Session backends remain an implementation detail of the concrete service.
 */
export interface SubagentService {
	availableSlots(workflowId: WorkflowId): number;
	spawn(input: SpawnSubagentInput): Promise<AgentInstance>;
	reserveWriter(agentId: AgentId): string | undefined;
	send(agentId: AgentId, message: string): Promise<void>;
	resume(agentId: AgentId, message: string): Promise<void>;
	wait(agentId: AgentId): Promise<AgentRunResult>;
	interrupt(agentId: AgentId, reason?: string): Promise<AgentRunResult>;
	release(agentId: AgentId): Promise<void>;
	retry(agentId: AgentId, input: RetrySubagentInput): Promise<AgentInstance>;
	get(agentId: AgentId): AgentInstance | undefined;
	list(workflowId?: WorkflowId): readonly AgentInstance[];
	getHandoff(handoffId: HandoffId): Handoff | undefined;
	events(agentId?: AgentId): readonly AgentRuntimeEvent[];
	getTranscript(agentId: AgentId): AgentTranscriptView;
	subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
	cancelWorkflow(workflowId: WorkflowId, reason: string): Promise<readonly AgentRunResult[]>;
	dispose(): Promise<void>;
}
