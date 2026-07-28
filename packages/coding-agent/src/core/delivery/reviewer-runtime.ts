import { randomUUID } from "node:crypto";
import type { SubagentService } from "../subagents/subagent-service.ts";
import { BUILTIN_AGENT_PROFILES } from "../workflow/agent-profile.ts";
import { FULL_PERMISSION_SET } from "../workflow/runtime-policy.ts";
import type { ReadonlyReviewer, ReviewResult } from "./types.ts";

const REVIEW_PASSED = "review:passed";
const REVIEW_FAILED = "review:failed";

export class SubagentReadonlyReviewer implements ReadonlyReviewer {
	readonly #runtime: SubagentService;

	constructor(runtime: SubagentService) {
		this.#runtime = runtime;
	}

	async review(input: Parameters<ReadonlyReviewer["review"]>[0]): Promise<ReviewResult> {
		const readOnlyPermission = {
			...FULL_PERMISSION_SET,
			write: false,
			executeCommands: false,
			network: false,
		};
		const agent = await this.#runtime.spawn({
			workflowId: input.workflow.id,
			taskId: input.rootTask.id,
			attemptId: `review-${randomUUID()}`,
			cwd: input.workflow.request.cwd,
			profile: BUILTIN_AGENT_PROFILES.reviewer,
			scope: "workflow",
			parentPermission: readOnlyPermission,
			workflowPermission: readOnlyPermission,
			taskPermission: readOnlyPermission,
			parentBudget: input.workflow.budget,
			workflowBudget: input.workflow.budget,
			taskBudget: BUILTIN_AGENT_PROFILES.reviewer.defaultBudget,
		});
		await this.#runtime.send(
			agent.id,
			[
				"Review this scoped delivery diff for correctness, safety, omissions, and unnecessary changes.",
				`Return ${REVIEW_PASSED} or ${REVIEW_FAILED} as one verificationSummary item.`,
				"Put actionable problems in unfinishedItems and exact file evidence in evidence.",
				JSON.stringify(input.diff),
			].join("\n"),
		);
		const result = await this.#runtime.wait(agent.id);
		if (result.status !== "completed" || !result.handoff) {
			return {
				status: "failed",
				summary: result.error ?? "Reviewer did not complete",
				evidenceRefs: [],
				risks: [],
				unfinishedItems: [result.error ?? "Reviewer did not complete"],
			};
		}
		const verdicts = result.handoff.verificationSummary.map((entry) => entry.trim().toLowerCase());
		const passed = verdicts.includes(REVIEW_PASSED) && !verdicts.includes(REVIEW_FAILED);
		return {
			status: passed ? "passed" : "failed",
			summary: result.handoff.conclusion,
			evidenceRefs: result.handoff.evidence.map(
				({ path, line }) => `${path}${line === undefined ? "" : `:${line}`}`,
			),
			risks: [...result.handoff.risks],
			unfinishedItems: passed ? [] : [...result.handoff.unfinishedItems],
			handoff: result.handoff,
		};
	}
}
