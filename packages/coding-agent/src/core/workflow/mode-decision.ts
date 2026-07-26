import type { ModeSelection } from "./mode-selector.ts";
import type { IsoDateTime, ModeDecision, RiskLevel } from "./types.ts";

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

export interface CreateModeDecisionInput {
	readonly selection: ModeSelection;
	readonly reason: string;
	readonly riskLevel: RiskLevel;
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
	if (!Number.isFinite(Date.parse(input.decidedAt))) {
		throw new ModeDecisionError("mode_decision.invalid_timestamp", "Mode decision timestamp must be valid");
	}
	return {
		mode: input.selection.mode,
		source: input.selection.source,
		reason,
		riskLevel: input.riskLevel,
		decidedAt: input.decidedAt,
	};
}
