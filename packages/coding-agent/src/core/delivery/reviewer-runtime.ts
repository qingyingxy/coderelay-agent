import { randomUUID } from "node:crypto";
import type { SubagentService } from "../subagents/subagent-service.ts";
import { BUILTIN_AGENT_PROFILES } from "../workflow/agent-profile.ts";
import { FULL_PERMISSION_SET } from "../workflow/runtime-policy.ts";
import type { ReadonlyReviewer, ReviewResult } from "./types.ts";

const REVIEW_PASSED = "review:passed";
const REVIEW_FAILED = "review:failed";
const REVIEW_PASSED_VERDICT = /(?:^|[;.!?]\s*)review:passed\b/i;
const REVIEW_FAILED_VERDICT = /\breview:failed\b/i;

type ReviewVerdict = "passed" | "failed";

function reviewVerdict(verificationSummary: readonly string[]): ReviewVerdict | undefined {
	const verdicts = verificationSummary.map((entry) => entry.trim());
	if (verdicts.some((entry) => REVIEW_FAILED_VERDICT.test(entry))) {
		return "failed";
	}
	return verdicts.some((entry) => REVIEW_PASSED_VERDICT.test(entry)) ? "passed" : undefined;
}

function hasFailedReview(runtime: SubagentService, workflowId: string, taskId: string): boolean {
	return runtime.list(workflowId).some((agent) => {
		const isReviewer =
			agent.profile?.role === "reviewer" || agent.profileName === BUILTIN_AGENT_PROFILES.reviewer.name;
		if (agent.taskId !== taskId || !isReviewer) {
			return false;
		}
		if (agent.status === "failed" || agent.status === "interrupted") {
			return true;
		}
		const handoff = agent.handoffId ? runtime.getHandoff(agent.handoffId) : undefined;
		return handoff ? reviewVerdict(handoff.verificationSummary) !== "passed" : false;
	});
}

export class SubagentReadonlyReviewer implements ReadonlyReviewer {
	readonly #runtime: SubagentService;

	constructor(runtime: SubagentService) {
		this.#runtime = runtime;
	}

	async review(input: Parameters<ReadonlyReviewer["review"]>[0]): Promise<ReviewResult> {
		const modelEscalationReason = hasFailedReview(this.#runtime, input.workflow.id, input.rootTask.id)
			? "retry"
			: undefined;
		const readOnlyPermission = {
			...FULL_PERMISSION_SET,
			write: false,
			executeCommands: false,
			network: false,
		};
		const workflowDeadlineAtMs =
			input.workflow.budget.maxDurationMs === undefined
				? undefined
				: Date.parse(input.workflow.createdAt) + input.workflow.budget.maxDurationMs;
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
			workflowDeadlineAtMs,
			riskLevel: input.workflow.modeDecision?.riskLevel,
			modelEscalationReason,
		});
		await this.#runtime.send(
			agent.id,
			[
				"Review this scoped delivery diff for correctness, safety, omissions, and unnecessary changes.",
				"Inspect only the changed paths and hunks in the supplied diff. Do not explore unrelated repository files.",
				`Start one verificationSummary item with exactly ${REVIEW_PASSED} or ${REVIEW_FAILED}; any explanation follows that verdict.`,
				"Put actionable problems in unfinishedItems and exact file evidence in evidence, then return the structured Handoff.",
				JSON.stringify(input.diff),
			].join("\n"),
		);
		let result = await this.#runtime.wait(agent.id);
		if (result.status !== "completed" || !result.handoff) {
			const failure = result.error ?? "Reviewer did not complete";
			const retry = await this.#runtime.retry(agent.id, {
				attemptId: `review-${randomUUID()}`,
				failureReason: failure,
				modelEscalationReason: "retry",
			});
			result = await this.#runtime.wait(retry.id);
		}
		if (result.status === "completed" && result.handoff && !reviewVerdict(result.handoff.verificationSummary)) {
			await this.#runtime.resume(
				result.agentId,
				[
					"Reviewer protocol error: verificationSummary is missing an explicit verdict.",
					`Do not call tools or repeat the review. Return the complete corrected structured Handoff now with one verificationSummary item starting exactly ${REVIEW_PASSED} or ${REVIEW_FAILED}.`,
				].join("\n"),
			);
			result = await this.#runtime.wait(result.agentId);
		}
		if (result.status !== "completed" || !result.handoff) {
			return {
				status: "failed",
				summary: result.error ?? "Reviewer did not complete",
				evidenceRefs: [],
				risks: [],
				unfinishedItems: [result.error ?? "Reviewer did not complete"],
				failureKind: "infrastructure",
			};
		}
		const verdict = reviewVerdict(result.handoff.verificationSummary);
		if (!verdict) {
			return {
				status: "failed",
				summary: "Reviewer returned no explicit review verdict after one correction",
				evidenceRefs: [],
				risks: [],
				unfinishedItems: ["Reviewer protocol remained invalid after one correction"],
				failureKind: "infrastructure",
				handoff: result.handoff,
			};
		}
		const passed = verdict === "passed";
		return {
			status: passed ? "passed" : "failed",
			failureKind: passed ? undefined : "finding",
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
