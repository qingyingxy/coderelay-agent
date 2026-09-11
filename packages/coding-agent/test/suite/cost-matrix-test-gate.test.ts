import { expect, it } from "vitest";
import { completeDelivery } from "../../evals/cost-matrix/delivery-cycle.ts";

it.each([0, 1])("stops at passing tests after %i repairs even with review findings", async (failures) => {
	let repairs = 0;
	const trace: string[] = [];
	const result = await completeDelivery({
		completionCriterion: "tests",
		async verify(attempt) {
			trace.push(`verify-${attempt}`);
			return {
				passed: attempt >= failures,
				infrastructureComplete: true,
				log: "host evidence",
				command: "offline",
				exitCode: attempt >= failures ? 0 : 1,
			};
		},
		async review(_, attempt) {
			trace.push(`review-${attempt}`);
			return {
				status: "failed",
				failureKind: "finding",
				summary: "Separate quality finding",
				evidenceRefs: [],
				risks: [],
				unfinishedItems: [],
			};
		},
		async repair() {
			repairs++;
		},
	});
	expect(result.passed).toBe(true);
	expect(repairs).toBe(failures);
	expect(trace).toEqual(failures ? ["verify-0", "review-0", "verify-1", "review-1"] : ["verify-0", "review-0"]);
});
