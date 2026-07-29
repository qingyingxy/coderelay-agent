import type { ModeDecisionSource, ResolvedExecutionMode } from "./types.ts";

export const MODE_DECISION_REASON_CODES = [
	"mode.user_direct",
	"mode.user_plan",
	"mode.policy_plan_required",
	"mode.agent_direct",
	"mode.agent_plan",
	"mode.default_direct",
	"mode.default_plan",
] as const;
export type ModeDecisionReasonCode = (typeof MODE_DECISION_REASON_CODES)[number];

export const AGENT_CREATION_REASON_CODES = [
	"agent.exploration_requested",
	"agent.review_requested",
	"agent.writer_task_ready",
	"agent.read_only_task_ready",
	"agent.repair_task_ready",
	"agent.retry_requested",
	"agent.recovery_required",
	"agent.delegation_requested",
] as const;
export type AgentCreationReasonCode = (typeof AGENT_CREATION_REASON_CODES)[number];

export const BACKEND_SELECTION_REASON_CODES = [
	"backend.explicit_in_process",
	"backend.auto_safe_in_process",
	"backend.auto_rpc_fallback",
	"backend.default_rpc",
] as const;
export type BackendSelectionReasonCode = (typeof BACKEND_SELECTION_REASON_CODES)[number];

export const SCHEDULING_REASON_CODES = [
	"scheduler.selected",
	"scheduler.writer_active",
	"scheduler.writer_capacity_exhausted",
	"scheduler.global_capacity_exhausted",
	"scheduler.agent_capacity_exhausted",
	"scheduler.job_capacity_exhausted",
	"scheduler.writer_unavailable",
	"scheduler.read_only_parallel_only",
] as const;
export type SchedulingReasonCode = (typeof SCHEDULING_REASON_CODES)[number];

export const REPAIR_DECISION_REASON_CODES = [
	"repair.verification_failed",
	"repair.disabled",
	"repair.no_changes",
	"repair.repeated_failure",
	"repair.budget_exhausted",
] as const;
export type RepairDecisionReasonCode = (typeof REPAIR_DECISION_REASON_CODES)[number];

export const RETRY_DECISION_REASON_CODES = [
	"retry.transient_error",
	"retry.succeeded",
	"retry.exhausted",
	"retry.cancelled",
] as const;
export type RetryDecisionReasonCode = (typeof RETRY_DECISION_REASON_CODES)[number];

export type DecisionReasonCode =
	| ModeDecisionReasonCode
	| AgentCreationReasonCode
	| BackendSelectionReasonCode
	| SchedulingReasonCode
	| RepairDecisionReasonCode
	| RetryDecisionReasonCode
	| `automation.${string}`;

export interface DecisionExplanation {
	readonly category: "mode" | "agent" | "backend" | "scheduler" | "repair" | "automation";
	readonly reasonCode: DecisionReasonCode;
	readonly summary: string;
	readonly entityId?: string;
}

export function resolveModeDecisionReasonCode(
	mode: ResolvedExecutionMode,
	source: ModeDecisionSource,
): ModeDecisionReasonCode {
	switch (source) {
		case "user":
			return mode === "plan" ? "mode.user_plan" : "mode.user_direct";
		case "forced_policy":
			return "mode.policy_plan_required";
		case "agent":
			return mode === "plan" ? "mode.agent_plan" : "mode.agent_direct";
		case "default":
			return mode === "plan" ? "mode.default_plan" : "mode.default_direct";
	}
}
