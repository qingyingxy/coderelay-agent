import type { SessionEntry, SessionManager } from "../session-manager.ts";
import type { AgentInstance } from "../subagents/types.ts";
import type { WorkflowView } from "./view.ts";

export const WORKFLOW_COST_SCOPE = "workflow-cost-scope";
export const WORKFLOW_COST_BINDING = "workflow-cost-binding";
export const WORKFLOW_COST_STAGES = ["planning", "execution", "review", "repair", "other"] as const;
export type WorkflowCostStage = (typeof WORKFLOW_COST_STAGES)[number];

export interface WorkflowCost {
	estimatedUsd: Record<WorkflowCostStage, number>;
	totalEstimatedUsd: number;
	/** Unattributed historical host usage is never borrowed from another task. */
	hostAttributed: boolean;
}

interface CostScope {
	scopeId: string;
	stage: WorkflowCostStage;
}

function readScope(entry: SessionEntry): CostScope | undefined {
	if (entry.type !== "custom" || entry.customType !== WORKFLOW_COST_SCOPE) return undefined;
	const data = entry.data;
	if (
		!data ||
		typeof data !== "object" ||
		!("scopeId" in data) ||
		typeof data.scopeId !== "string" ||
		!("stage" in data) ||
		!WORKFLOW_COST_STAGES.some((stage) => stage === data.stage)
	)
		return undefined;
	return { scopeId: data.scopeId, stage: data.stage as WorkflowCostStage };
}

export function currentWorkflowCostScope(manager: SessionManager): CostScope | undefined {
	for (const entry of manager.getBranch().reverse()) {
		const scope = readScope(entry);
		if (scope) return scope;
	}
	return undefined;
}

export function workflowCostStage(role: string): WorkflowCostStage {
	switch (role) {
		case "planner":
		case "planner_lite":
			return "planning";
		case "worker":
		case "main":
			return "execution";
		case "reviewer":
			return "review";
		case "repair":
			return "repair";
		default:
			return "other";
	}
}

export function collectWorkflowCost(entries: readonly SessionEntry[], view: WorkflowView): WorkflowCost {
	const bindings = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== WORKFLOW_COST_BINDING) continue;
		const data = entry.data;
		if (
			data &&
			typeof data === "object" &&
			"scopeId" in data &&
			typeof data.scopeId === "string" &&
			"workflowId" in data &&
			typeof data.workflowId === "string"
		)
			bindings.set(data.scopeId, data.workflowId);
	}
	const result: WorkflowCost = {
		estimatedUsd: { planning: 0, execution: 0, review: 0, repair: 0, other: 0 },
		totalEstimatedUsd: 0,
		hostAttributed: [...bindings.values()].includes(view.workflow.id),
	};
	// Follow ancestry for attribution, but count all billed branches, not just the active window.
	const scopes = new Map<string, CostScope | undefined>();
	for (const entry of entries) {
		if (scopes.has(entry.id)) continue;
		const scope = readScope(entry) ?? (entry.parentId ? scopes.get(entry.parentId) : undefined);
		scopes.set(entry.id, scope);
		if (!scope || bindings.get(scope.scopeId) !== view.workflow.id) continue;
		const usage =
			entry.type === "compaction" || entry.type === "branch_summary"
				? entry.usage
				: entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
					? entry.message.usage
					: undefined;
		if (usage) result.estimatedUsd[scope.stage] += usage.cost.total;
	}
	// Agent usage is cumulative; attempt/task/workflow aggregates contain the same charges.
	const agents = new Map<string, AgentInstance>();
	for (const agent of view.agents) {
		if (agent.workflowId !== view.workflow.id) continue;
		const previous = agents.get(agent.id);
		if (!previous || previous.revision < agent.revision) agents.set(agent.id, agent);
	}
	for (const agent of agents.values()) {
		const task = view.tasks.find(({ id }) => id === agent.taskId);
		const role = agent.modelRoute?.role ?? agent.profile?.role ?? agent.profileName;
		const stage = task?.kind === "repair" && role !== "reviewer" ? "repair" : workflowCostStage(role);
		result.estimatedUsd[stage] += agent.usage.cost;
	}
	result.totalEstimatedUsd = Object.values(result.estimatedUsd).reduce((total, cost) => total + cost, 0);
	return result;
}

export function formatWorkflowCost(cost: WorkflowCost): string {
	return `Recorded cost (estimated USD${cost.hostAttributed ? "" : "; host unattributed"}): ${WORKFLOW_COST_STAGES.map((stage) => `${stage} $${cost.estimatedUsd[stage].toFixed(6)}`).join(" | ")} | total $${cost.totalEstimatedUsd.toFixed(6)}`;
}
