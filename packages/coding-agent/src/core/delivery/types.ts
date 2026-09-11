import type { Handoff } from "../subagents/types.ts";
import type { RepairDecisionReasonCode } from "../workflow/decision-reasons.ts";
import type {
	AttemptId,
	FileModificationRecord,
	ResourceUsage,
	Task,
	VerificationRequirement,
	VerificationResult,
	Workflow,
} from "../workflow/types.ts";
import type { DeliveryBaseline } from "./baseline.ts";

export interface DeliveryFileOwner {
	readonly taskId: string;
	readonly attemptId?: AttemptId;
	readonly agentId?: string;
	readonly operations: readonly FileModificationRecord["operation"][];
}

export interface DeliveryFileDiff {
	readonly unavailableReason?: string;
	readonly path: string;
	readonly patch: string;
	readonly owners: readonly DeliveryFileOwner[];
	readonly truncated: boolean;
}

export interface DeliveryDiff {
	readonly files: readonly DeliveryFileDiff[];
	readonly changedFiles: readonly string[];
	readonly summary: string;
	readonly evidenceRefs: readonly string[];
}

export interface ReviewResult {
	readonly status: "passed" | "failed";
	readonly failureKind?: "finding" | "infrastructure" | "confirmation";
	readonly summary: string;
	readonly evidenceRefs: readonly string[];
	readonly risks: readonly string[];
	readonly unfinishedItems: readonly string[];
	readonly handoff?: Handoff;
}

export interface ReadonlyReviewer {
	review(input: {
		readonly workflow: Workflow;
		readonly rootTask: Task;
		readonly diff: DeliveryDiff;
		readonly acceptanceRequirements?: readonly VerificationRequirement[];
		readonly verificationEvidence?: readonly {
			readonly result: VerificationResult;
			readonly logExcerpt?: string;
			readonly logsTruncated?: boolean;
		}[];
	}): Promise<ReviewResult>;
}

export interface DeliveryWorkflowPort {
	readonly deliveryBaseline?: DeliveryBaseline;
	readonly workflow: Workflow;
	readonly deliveryFingerprint?: string;
	readonly currentPlan: {
		readonly verificationRequirements: readonly VerificationRequirement[];
	};
	readonly tasks: readonly Task[];
	readonly verifications: readonly VerificationResult[];
	beginVerification(): void;
	recordVerification(input: {
		readonly verificationId: string;
		readonly requirementId: string;
		readonly actor?: {
			readonly kind: "controller" | "agent" | "job";
			readonly id?: string;
		};
		readonly status: Extract<VerificationResult["status"], "passed" | "failed" | "skipped">;
		readonly deliveryFingerprint?: string;
		readonly summary: string;
		readonly evidenceRefs?: readonly string[];
		readonly command?: string;
		readonly exitCode?: number;
		readonly skipReason?: string;
	}): void;
	createRepair(failedVerificationId: string): Task;
	completeDelivery(input: {
		readonly summary: string;
		readonly risks: readonly string[];
		readonly unfinishedItems: readonly string[];
		readonly deliveryFingerprint?: string;
	}): void;
	failDelivery(reason: string): void;
}

export interface DeliveryRunResult {
	readonly status: "completed" | "repair_created" | "failed";
	readonly reasonCode?: RepairDecisionReasonCode;
	readonly diff: DeliveryDiff;
	readonly verifications: readonly VerificationResult[];
	readonly repairTask?: Task;
	readonly risks: readonly string[];
	readonly unfinishedItems: readonly string[];
	readonly usage: ResourceUsage;
}

export interface DeliveryRunOptions {
	readonly allowRepair?: boolean;
}
