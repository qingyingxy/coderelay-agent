import { adviseExecutionMode, type ModeAdvice, type ModeAssessment } from "./mode-advisor.ts";
import type { DomainViolation } from "./transitions.ts";
import type { DirectPlanUpgradeTrigger, IsoDateTime } from "./types.ts";

export const DIRECT_PLAN_UPGRADE_SEQUENCE = [
	"persist_upgrade_request",
	"close_write_admission",
	"stop_active_writer",
	"create_draft_plan",
	"enter_planning",
	"generate_read_only_plan",
	"request_user_approval",
] as const;
export type DirectPlanUpgradeStep = (typeof DIRECT_PLAN_UPGRADE_SEQUENCE)[number];

interface DirectPlanUpgradeDecisionBase {
	readonly advice: ModeAdvice;
	readonly evaluatedAt: IsoDateTime;
}

export interface ContinueDirectDecision extends DirectPlanUpgradeDecisionBase {
	readonly action: "continue_direct";
}

export interface UpgradeDirectToPlanDecision extends DirectPlanUpgradeDecisionBase {
	readonly action: "upgrade_to_plan";
	readonly triggers: readonly DirectPlanUpgradeTrigger[];
	readonly requiredSequence: readonly DirectPlanUpgradeStep[];
}

export type DirectPlanUpgradeDecision = ContinueDirectDecision | UpgradeDirectToPlanDecision;

export interface DirectPlanUpgradeReadiness {
	readonly upgradeRequestPersisted: boolean;
	readonly writeAdmissionClosed: boolean;
	readonly activeWriterStopped: boolean;
	readonly draftPlanCreated: boolean;
}

export class DirectPlanUpgradeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DirectPlanUpgradeError";
		this.code = code;
	}
}

export function decideDirectPlanUpgrade(
	assessment: ModeAssessment,
	evaluatedAt: IsoDateTime,
): DirectPlanUpgradeDecision {
	if (!Number.isFinite(Date.parse(evaluatedAt))) {
		throw new DirectPlanUpgradeError(
			"direct_plan_upgrade.invalid_timestamp",
			"Direct Plan upgrade evaluation timestamp must be valid",
		);
	}
	const advice = adviseExecutionMode(assessment);
	if (advice.suggestedMode === "direct") {
		return {
			action: "continue_direct",
			advice,
			evaluatedAt,
		};
	}

	const triggers: DirectPlanUpgradeTrigger[] = [];
	if (advice.complexity === "high") {
		triggers.push("complexity");
	}
	if (advice.riskLevel !== "low") {
		triggers.push("risk");
	}
	if (advice.confidence === "low") {
		triggers.push("confidence");
	}
	return {
		action: "upgrade_to_plan",
		advice,
		evaluatedAt,
		triggers,
		requiredSequence: [...DIRECT_PLAN_UPGRADE_SEQUENCE],
	};
}

export function validateDirectPlanUpgradeReadiness(readiness: DirectPlanUpgradeReadiness): readonly DomainViolation[] {
	const violations: DomainViolation[] = [];
	if (!readiness.upgradeRequestPersisted) {
		violations.push({
			code: "direct_plan_upgrade.request_not_persisted",
			message: "The Direct Plan upgrade request must be persisted before leaving execution",
		});
	}
	if (!readiness.writeAdmissionClosed) {
		violations.push({
			code: "direct_plan_upgrade.write_admission_open",
			message: "New write operations must be blocked before entering planning",
		});
	}
	if (!readiness.activeWriterStopped) {
		violations.push({
			code: "direct_plan_upgrade.writer_active",
			message: "The active writer must stop before entering planning",
		});
	}
	if (!readiness.draftPlanCreated) {
		violations.push({
			code: "direct_plan_upgrade.plan_missing",
			message: "A draft Plan must be created before entering planning",
		});
	}
	return violations;
}
