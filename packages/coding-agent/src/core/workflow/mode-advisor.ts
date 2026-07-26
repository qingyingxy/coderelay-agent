import type { ResolvedExecutionMode, RiskLevel } from "./types.ts";

export const COMPLEXITY_LEVELS = ["low", "medium", "high"] as const;
export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

export const MODE_ADVICE_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ModeAdviceConfidence = (typeof MODE_ADVICE_CONFIDENCE_LEVELS)[number];

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

export interface ModeAssessment {
	readonly complexity: ComplexityLevel;
	readonly riskLevel: RiskLevel;
	readonly confidence: ModeAdviceConfidence;
	readonly reason: string;
}

export interface ModeAdvice extends ModeAssessment {
	readonly suggestedMode: ResolvedExecutionMode;
}

export class ModeAdviceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ModeAdviceError";
		this.code = code;
	}
}

export function adviseExecutionMode(assessment: ModeAssessment): ModeAdvice {
	if (!COMPLEXITY_LEVELS.includes(assessment.complexity)) {
		throw new ModeAdviceError(
			"mode_advice.invalid_complexity",
			`Unsupported complexity level: ${assessment.complexity}`,
		);
	}
	if (!RISK_LEVELS.includes(assessment.riskLevel)) {
		throw new ModeAdviceError("mode_advice.invalid_risk", `Unsupported risk level: ${assessment.riskLevel}`);
	}
	if (!MODE_ADVICE_CONFIDENCE_LEVELS.includes(assessment.confidence)) {
		throw new ModeAdviceError(
			"mode_advice.invalid_confidence",
			`Unsupported confidence level: ${assessment.confidence}`,
		);
	}
	const reason = assessment.reason.trim();
	if (!reason) {
		throw new ModeAdviceError("mode_advice.reason_required", "Mode advice reason is required");
	}

	const directAllowed =
		assessment.complexity !== "high" && assessment.riskLevel === "low" && assessment.confidence !== "low";
	return {
		complexity: assessment.complexity,
		riskLevel: assessment.riskLevel,
		confidence: assessment.confidence,
		reason,
		suggestedMode: directAllowed ? "direct" : "plan",
	};
}
