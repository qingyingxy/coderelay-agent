import { expect, it } from "vitest";
import { applyReviewBoundary } from "../../src/core/delivery/review-boundary.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { parseHandoff } from "../../src/core/subagents/handoff.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import { subagentHandoff } from "./subagent-fixtures.ts";

it.each([
	["Tools/Bridge/router.py:12 stale callback", ["Tools/Bridge/router.py"], "finding"],
	["Bridge/router.py:12 stale callback", ["Tools/Bridge/router.py"], "finding"],
	["Bridge\\router.py:12 stale callback", ["Tools/Bridge/router.py"], "finding"],
	["router.py:12 stale callback", ["Tools/Bridge/router.py", "Other/router.py"], "infrastructure"],
	["unrelated.py:12 stale callback", ["Tools/Bridge/router.py"], "infrastructure"],
	["../Bridge/router.py:12 stale callback", ["Tools/Bridge/router.py"], "infrastructure"],
	["Tools/Bridge/router.py:0 stale callback", ["Tools/Bridge/router.py"], "infrastructure"],
] as const)("validates evidence path %s", (reference, changedFiles, failureKind) => {
	const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: "paths",
		rootTaskId: "root",
		planId: "plan",
		request: { text: "Stop before ending", cwd: process.cwd(), attachments: [] },
	});
	const findings = [
		{
			category: "must_fix",
			basis: "requirement",
			summary: "Callback after end",
			evidence: [reference],
			introducedByChange: false,
			requirementId: "$request",
			requirementQuote: "Stop before ending",
		},
	];
	const handoff = parseHandoff(
		subagentHandoff({
			verificationSummary: ["review:failed", `review_findings:${JSON.stringify(findings)}`],
		}),
		{
			id: "h",
			agentId: "a",
			workflowId: "paths",
			taskId: "root",
			attemptId: "r",
			createdAt: new Date().toISOString(),
		},
	);
	const original = JSON.stringify(handoff);
	const result = applyReviewBoundary(
		{
			workflow: plan.workflow,
			rootTask: plan.tasks[0]!,
			diff: { files: [], changedFiles, summary: "Stop", evidenceRefs: [] },
		},
		{ status: "failed", summary: "Review", evidenceRefs: [], risks: [], unfinishedItems: [], handoff },
	);
	expect(result.status).toBe("failed");
	expect(result.failureKind).toBe(failureKind);
	if (failureKind === "finding") expect(result.evidenceRefs).toEqual(["Tools/Bridge/router.py:12 stale callback"]);
	expect(JSON.stringify(handoff)).toBe(original);
});

it.each(["suggestion", "mixed", "regression", "safety"])("classifies new-code findings: %s", (variant) => {
	const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: "new-code",
		rootTaskId: "root",
		planId: "plan",
		request: { text: "Retry failed resumption", cwd: process.cwd(), attachments: [] },
	});
	const suggestion = {
		category: "suggestion",
		basis: "hardening",
		summary: "Remove unused bookkeeping",
		evidence: ["router.py:73 unused counter"],
		introducedByChange: true,
		requirementId: null,
		requirementQuote: null,
	};
	const blocker = {
		...suggestion,
		category: "must_fix",
		basis: "requirement",
		summary: "Failed resume reports success",
		requirementId: "$request",
		requirementQuote: "Retry failed resumption",
	};
	const findings =
		variant === "mixed"
			? [suggestion, blocker]
			: [{ ...suggestion, basis: variant === "regression" || variant === "safety" ? variant : "hardening" }];
	const handoff = parseHandoff(
		subagentHandoff({ verificationSummary: ["review:failed", `review_findings:${JSON.stringify(findings)}`] }),
		{
			id: "h",
			agentId: "a",
			workflowId: plan.workflow.id,
			taskId: "root",
			attemptId: "r",
			createdAt: new Date().toISOString(),
		},
	);
	const result = applyReviewBoundary(
		{
			workflow: plan.workflow,
			rootTask: plan.tasks[0]!,
			diff: { files: [], changedFiles: ["router.py"], summary: "Resume", evidenceRefs: [] },
		},
		{ status: "failed", summary: "Review", evidenceRefs: [], risks: [], unfinishedItems: [], handoff },
	);
	expect(result.failureKind).toBe(
		variant === "suggestion" ? undefined : variant === "mixed" ? "finding" : "confirmation",
	);
	expect(result.status).toBe(variant === "suggestion" ? "passed" : "failed");
	if (variant === "mixed") {
		expect(result.unfinishedItems).toHaveLength(1);
		expect(result.unfinishedItems[0]).toContain("Failed resume reports success");
	}
});

it.each([false, true])("keeps passing evidence separate from user decisions (decision=%s)", (needsDecision) => {
	const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: "protocol",
		rootTaskId: "root",
		planId: "plan",
		request: { text: "Reject excessive decrements atomically", cwd: process.cwd(), attachments: [] },
	});
	const finding = {
		category: "confirmation",
		basis: "ambiguity",
		summary: "Should negative amounts be rejected? User decision needed.",
		evidence: ["src/counter-store.mjs:14 input contract is unspecified"],
		introducedByChange: false,
		requirementId: null,
		requirementQuote: null,
	};
	const handoff = parseHandoff(
		subagentHandoff({
			verificationSummary: [
				"review:passed",
				`review_findings:${JSON.stringify(needsDecision ? [finding] : [])}`,
				"Excessive decrements reject atomically; parent node --test passed 2/2 with exit code 0.",
			],
			unfinishedItems: needsDecision ? [finding.summary] : [],
		}),
		{
			id: "handoff",
			agentId: "reviewer",
			workflowId: "protocol",
			taskId: "root",
			attemptId: "review",
			createdAt: new Date().toISOString(),
		},
	);
	const result = applyReviewBoundary(
		{
			workflow: plan.workflow,
			rootTask: plan.tasks.find((task) => task.id === "root")!,
			diff: { files: [], changedFiles: ["src/counter-store.mjs"], summary: "Atomic rejection", evidenceRefs: [] },
		},
		{ status: "passed", summary: "Review passed", evidenceRefs: [], risks: [], unfinishedItems: [], handoff },
	);
	expect(result.status).toBe(needsDecision ? "failed" : "passed");
	expect(result.failureKind).toBe(needsDecision ? "confirmation" : undefined);
	expect(result.unfinishedItems).toEqual(needsDecision ? [expect.stringContaining("User decision needed")] : []);
});
