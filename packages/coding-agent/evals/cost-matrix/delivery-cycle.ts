import type { ReviewResult } from "../../src/core/delivery/types.ts";

export interface ExternalVerification {
	passed: boolean;
	infrastructureComplete: boolean;
	log: string;
	command: string;
	exitCode: number | null;
}

export async function completeDelivery(hooks: {
	completionCriterion?: "tests" | "tests-and-review";
	verify(attempt: number): Promise<ExternalVerification>;
	review(verification: ExternalVerification, attempt: number): Promise<ReviewResult>;
	repair(verification: ExternalVerification, review: ReviewResult): Promise<void>;
}) {
	let repairCount = 0;
	for (let attempt = 0; attempt < 2; attempt++) {
		const verification = await hooks.verify(attempt);
		if (!verification.infrastructureComplete) return { passed: false, repairCount, failure: "Acceptance infrastructure incomplete" };
		const review = await hooks.review(verification, attempt);
		if (verification.passed && (hooks.completionCriterion === "tests" || review.status === "passed")) return { passed: true, repairCount, review };
		if (attempt === 1 || review.failureKind === "confirmation" || review.failureKind === "infrastructure") {
			return { passed: false, repairCount, review, failure: review.summary || "Acceptance failed" };
		}
		repairCount++;
		await hooks.repair(verification, review);
	}
	throw new Error("Unreachable delivery state");
}
