import type { ModeDecisionSource, ResolvedExecutionMode } from "./types.ts";

export const DEFAULT_RESOLVED_EXECUTION_MODE: ResolvedExecutionMode = "direct";

export interface ModeSelectionInput {
	readonly requestedMode?: ResolvedExecutionMode;
	readonly forcePlan?: boolean;
	readonly agentSuggestedMode?: ResolvedExecutionMode;
	readonly defaultMode?: ResolvedExecutionMode;
}

export interface ModeSelection {
	readonly mode: ResolvedExecutionMode;
	readonly source: ModeDecisionSource;
}

export function selectExecutionMode(input: ModeSelectionInput): ModeSelection {
	if (input.requestedMode === "plan") {
		return { mode: "plan", source: "user" };
	}
	if (input.forcePlan) {
		return { mode: "plan", source: "forced_policy" };
	}
	if (input.requestedMode === "direct") {
		return { mode: "direct", source: "user" };
	}
	if (input.agentSuggestedMode) {
		return { mode: input.agentSuggestedMode, source: "agent" };
	}
	return {
		mode: input.defaultMode ?? DEFAULT_RESOLVED_EXECUTION_MODE,
		source: "default",
	};
}
