import type { ReadonlyReviewer, ReviewResult } from "./types.ts";

export const REVIEW_FINDINGS_PREFIX = "review_findings:";
export const REVIEW_BOUNDARY_INSTRUCTION = [
	"Review only the original request and approved acceptance requirements supplied below. Repairs do not expand that scope.",
	"Classify each finding as must_fix, suggestion, or confirmation. Pre-existing out-of-scope hardening is a suggestion, not a blocker.",
	"Optional cleanup or hardening remains a suggestion even when introduced by this change. introducedByChange records origin, not severity; requirement violations and behavioral regressions remain must_fix.",
	"review_findings is a list of problems or proposed improvements, not a checklist of successful checks. Put satisfied requirements and passing test evidence in ordinary verificationSummary entries, never in review_findings.",
	"confirmation means NEEDS USER DECISION: an unresolved question that prevents delivery. It never means 'confirmed correct', 'verified', or 'test passed'. State the unresolved question and the decision needed from the user in both the finding summary and unfinishedItems.",
	"must_fix requires evidence of an explicit requirement violation or a regression introduced by this change. Generic 'review passes' requirements do not authorize unrelated hardening.",
	"Ambiguous input contracts, behavior-changing scope extensions, and serious safety/data-loss risks require confirmation; do not invent a requirement or automatically repair them.",
	"Include one verificationSummary item starting review_findings: followed by a JSON array (use [] if none). Each object must contain category, basis (requirement|regression|hardening|ambiguity|safety), summary, evidence (nonempty string array of file:line and explanation), introducedByChange (boolean), requirementId (string or null), requirementQuote (string or null).",
	"For requirement violations use an approved requirement ID or $request, and quote the specific violated clause exactly. For regressions explain the before/after behavior in evidence.",
	"Use workspace-relative file paths exactly as listed in changedFiles, with forward slashes and a positive line number (path:line explanation), in both evidence and review_findings. Do not shorten paths.",
	"A must_fix claim must identify a reachable trigger and concrete violated behavior. Manually injecting an otherwise unreachable state is not sufficient evidence of a requirement violation; distinguish optional hardening from actual failures.",
	"Use review:passed when there are only suggestions or no findings; review:failed otherwise. Keep suggestions out of unfinishedItems. Never add new acceptance criteria during re-review.",
	'Passing example: verificationSummary = ["review:passed", "review_findings:[]", "Excessive decrement rejects before mutation; parent tests passed."], unfinishedItems = []. Do not create confirmation findings for these successful checks.',
	"Before returning, check consistency: any confirmation or must_fix requires review:failed. If all requirements are satisfied and there are no suggestions or unresolved decisions, return review:passed with review_findings:[].",
].join("\n");

/** Validate structure and scope anchors; semantic truth still requires model evidence and external tests. */
export function applyReviewBoundary(
	input: Parameters<ReadonlyReviewer["review"]>[0],
	result: ReviewResult,
): ReviewResult {
	const entries =
		result.handoff?.verificationSummary.filter((entry) => entry.startsWith(REVIEW_FINDINGS_PREFIX)) ?? [];
	const stop = (reason: string): ReviewResult => ({
		...result,
		status: "failed",
		failureKind: "confirmation",
		summary: `Review requires confirmation: ${reason}`,
		unfinishedItems: [reason],
	});
	if (entries.length === 0 && result.status === "passed" && !result.handoff?.unfinishedItems.length) return result;
	if (entries.length !== 1)
		return stop("Missing or duplicated structured review findings; no automatic repair authorized");
	let parsed: unknown;
	try {
		parsed = JSON.parse(entries[0]!.slice(REVIEW_FINDINGS_PREFIX.length));
	} catch {
		return stop("Malformed structured review findings; no automatic repair authorized");
	}
	if (!Array.isArray(parsed)) return stop("Review findings must be an array");
	const blockers: string[] = [];
	const suggestions: string[] = [];
	const questions: string[] = [];
	const protocolErrors: string[] = [];
	const evidenceRefs: string[] = [];
	for (const raw of parsed as unknown[]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return stop("Invalid review finding");
		const finding = raw as Record<string, unknown>;
		if (
			typeof finding.category !== "string" ||
			!["must_fix", "suggestion", "confirmation"].includes(finding.category) ||
			typeof finding.basis !== "string" ||
			!["requirement", "regression", "hardening", "ambiguity", "safety"].includes(finding.basis) ||
			typeof finding.summary !== "string" ||
			!finding.summary.trim() ||
			typeof finding.introducedByChange !== "boolean" ||
			!(finding.requirementId === null || typeof finding.requirementId === "string") ||
			!(finding.requirementQuote === null || typeof finding.requirementQuote === "string") ||
			!Array.isArray(finding.evidence) ||
			!finding.evidence.length ||
			finding.evidence.some((value: unknown) => typeof value !== "string" || !value.trim())
		)
			return stop("Incomplete finding classification or evidence");
		const evidence = (finding.evidence as string[]).map((reference) => {
			const match = /^([^:]+):([1-9]\d*)(?=\s|$)/.exec(reference);
			if (!match) return reference;
			const path = match[1]!.replaceAll("\\", "/");
			if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".."))
				return reference;
			const exact = input.diff.changedFiles.find((file) => file === path);
			const matches = exact ? [exact] : input.diff.changedFiles.filter((file) => file.endsWith(`/${path}`));
			return matches.length === 1 ? `${matches[0]}${reference.slice(match[1]!.length)}` : reference;
		});
		evidenceRefs.push(...evidence);
		const description = `${finding.summary} Evidence: ${evidence.join("; ")}`;
		if (finding.category === "confirmation" || finding.basis === "ambiguity" || finding.basis === "safety") {
			questions.push(description);
			continue;
		}
		if (finding.category === "suggestion") {
			if (finding.basis === "hardening") suggestions.push(description);
			else questions.push(`Conflicting suggestion classification: ${description}`);
			continue;
		}
		const requirementText =
			finding.requirementId === "$request"
				? input.workflow.request.text
				: input.acceptanceRequirements?.find((requirement) => requirement.id === finding.requirementId)
						?.description;
		const anchored =
			finding.basis === "requirement" &&
			typeof finding.requirementQuote === "string" &&
			Boolean(finding.requirementQuote.trim()) &&
			requirementText?.includes(finding.requirementQuote);
		const regression = finding.basis === "regression" && finding.introducedByChange;
		const scopedEvidence = evidence.some((reference) =>
			input.diff.changedFiles.some(
				(path) => reference.startsWith(`${path}:`) && /^[1-9]\d*(?=\s|$)/.test(reference.slice(path.length + 1)),
			),
		);
		if ((anchored || regression) && scopedEvidence) blockers.push(description);
		else if ((anchored || regression) && !scopedEvidence)
			protocolErrors.push(
				`Review evidence must identify an unambiguous changed file and positive line: ${description}`,
			);
		else questions.push(`Unsubstantiated must-fix claim: ${description}`);
	}
	const classified = { ...result, evidenceRefs, risks: [...result.risks, ...suggestions] };
	if (protocolErrors.length)
		return {
			...classified,
			status: "failed",
			failureKind: "infrastructure",
			summary: `Review evidence protocol error: ${protocolErrors.join("; ")}`,
			unfinishedItems: [...protocolErrors, ...questions, ...blockers],
		};
	if (questions.length)
		return {
			...classified,
			status: "failed",
			failureKind: "confirmation",
			summary: `Review requires confirmation: ${questions.join("; ")}`,
			unfinishedItems: [...questions, ...blockers],
		};
	if (blockers.length)
		return {
			...classified,
			status: "failed",
			failureKind: "finding",
			summary: `Review must-fix: ${blockers.join("; ")}`,
			unfinishedItems: blockers,
		};
	if (!parsed.length && result.status === "failed") return stop("Failed review has no classified finding");
	return {
		...classified,
		status: "passed",
		failureKind: undefined,
		summary: suggestions.length ? `Review passed with suggestions: ${suggestions.join("; ")}` : "Review passed",
		unfinishedItems: [],
	};
}
