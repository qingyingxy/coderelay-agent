import { resolveModeDecisionReasonCode } from "./decision-reasons.ts";
import type { ModeSelection } from "./mode-selector.ts";
import { type IsoDateTime, type ModeDecision, type RiskLevel, TASK_LEVELS, type TaskLevel } from "./types.ts";

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

export interface CreateModeDecisionInput {
	readonly selection: ModeSelection;
	readonly reason: string;
	readonly riskLevel: RiskLevel;
	readonly taskLevel?: TaskLevel;
	readonly decidedAt: IsoDateTime;
}

export class ModeDecisionError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ModeDecisionError";
		this.code = code;
	}
}

export function createModeDecision(input: CreateModeDecisionInput): ModeDecision {
	const reason = input.reason.trim();
	if (!reason) {
		throw new ModeDecisionError("mode_decision.reason_required", "Mode decision reason is required");
	}
	if (!RISK_LEVELS.includes(input.riskLevel)) {
		throw new ModeDecisionError("mode_decision.invalid_risk", `Unsupported risk level: ${input.riskLevel}`);
	}
	if (input.taskLevel !== undefined && !TASK_LEVELS.includes(input.taskLevel)) {
		throw new ModeDecisionError("mode_decision.invalid_task_level", `Unsupported task level: ${input.taskLevel}`);
	}
	if (!Number.isFinite(Date.parse(input.decidedAt))) {
		throw new ModeDecisionError("mode_decision.invalid_timestamp", "Mode decision timestamp must be valid");
	}
	return {
		mode: input.selection.mode,
		source: input.selection.source,
		reasonCode: resolveModeDecisionReasonCode(input.selection.mode, input.selection.source),
		reason,
		riskLevel: input.riskLevel,
		...(input.taskLevel ? { taskLevel: input.taskLevel } : {}),
		decidedAt: input.decidedAt,
	};
}
