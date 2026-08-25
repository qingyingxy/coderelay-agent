import type { ModelRouteRole } from "../workflow/model-gateway.ts";
import type { EvaluationExpectedModelRoute, EvaluationFailureType, EvaluationProtocolStatus } from "./types.ts";

export interface EvaluationProtocolAssessment {
	readonly violations: readonly string[];
	readonly protocolStatePresent: boolean;
	readonly protocolRunFailedOrIncomplete: boolean;
	readonly verificationFailed: boolean;
	readonly verificationIntegrityPassed: boolean;
	readonly infrastructureFailure: boolean;
	readonly protocolRuntimeFailure: boolean;
}

export interface EvaluationFailureAssessment {
	readonly succeeded: boolean;
	readonly verificationIntegrityPassed: boolean;
	readonly infrastructureFailure: boolean;
	readonly timedOut: boolean;
	readonly protocolStatus: EvaluationProtocolStatus;
	readonly runtimeFailed: boolean;
	readonly budgetExceeded: boolean;
}

export interface EvaluationRepairSummary {
	readonly attempts: number;
	readonly successes: number;
}

export function remainingEvaluationDurationMs(deadlineAtMs: number, nowMs = Date.now()): number {
	return Math.max(0, deadlineAtMs - nowMs);
}

export function assessEvaluationProtocol(input: EvaluationProtocolAssessment): EvaluationProtocolStatus {
	if (input.violations.length === 0) return "satisfied";
	if (
		input.protocolStatePresent &&
		!input.protocolRunFailedOrIncomplete &&
		input.verificationFailed &&
		input.verificationIntegrityPassed &&
		!input.infrastructureFailure &&
		!input.protocolRuntimeFailure
	) {
		return "not_reached_after_quality_failure";
	}
	return "violated";
}

export function classifyEvaluationFailure(input: EvaluationFailureAssessment): EvaluationFailureType | undefined {
	if (input.succeeded) return undefined;
	if (!input.verificationIntegrityPassed) return "verification_integrity";
	if (input.infrastructureFailure) return "infrastructure";
	if (input.timedOut) return "timeout";
	if (input.protocolStatus === "violated") return "strategy_protocol";
	if (input.runtimeFailed) return "model";
	if (input.budgetExceeded) return "budget";
	return "verification";
}

export function isEvaluationInfrastructureFailure(message: string | undefined): boolean {
	if (!message) return false;
	const normalized = message.toLowerCase();
	return [
		/\b401\b/,
		/\b402\b/,
		/\b403\b/,
		/\b503\b/,
		/insufficient[_ ](?:balance|quota|credits?)/,
		/payment required/,
		/billing (?:error|limit|issue)/,
		/invalid[_ ]api[_ ]key/,
		/authentication failed/,
		/unauthori[sz]ed/,
		/service unavailable/,
		/provider unavailable/,
	].some((pattern) => pattern.test(normalized));
}

export function summarizeEvaluationRepairs(
	repairTaskStatuses: readonly string[],
	routedRepairAttempts: number,
	runSucceeded: boolean,
): EvaluationRepairSummary {
	const attempts = Math.max(repairTaskStatuses.length, routedRepairAttempts);
	const taskSuccesses = repairTaskStatuses.filter((status) => status === "succeeded").length;
	const directSuccesses = routedRepairAttempts > 0 && runSucceeded ? 1 : 0;
	return { attempts, successes: Math.max(taskSuccesses, directSuccesses) };
}

export function countReachedModelRoutes(
	expectedRoutes: readonly EvaluationExpectedModelRoute[] | undefined,
	reachedRoleCounts: Readonly<Partial<Record<ModelRouteRole, number>>>,
): number {
	return (
		expectedRoutes?.reduce(
			(total, expected) => total + Math.min(reachedRoleCounts[expected.role] ?? 0, expected.minimumCount),
			0,
		) ?? 0
	);
}
