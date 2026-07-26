import { isWorkflowTerminalStatus } from "./transitions.ts";
import type {
	Attempt,
	ResourceUsage,
	Task,
	VerificationKind,
	VerificationResult,
	Workflow,
	WorkflowTerminalStatus,
} from "./types.ts";

/**
 * A single verification check surfaced in the M1 basic-verification report.
 *
 * M1 does not run Review/Test/Build, so these checks are always reported as
 * `not_configured`. The completion condition forbids presenting an unconfigured
 * check as passing, so the status is explicit rather than implied.
 */
export interface BasicVerificationCheck {
	readonly kind: Extract<VerificationKind, "review" | "test" | "build">;
	readonly label: string;
	readonly status: "not_configured";
}

export interface BasicVerificationReport {
	readonly changedFiles: readonly string[];
	readonly checks: readonly BasicVerificationCheck[];
	/** Human-readable lines, e.g. `Code review: not configured`. */
	readonly lines: readonly string[];
	/** Machine-readable refs persisted on the VerificationResult, e.g. `review:not-configured`. */
	readonly evidenceRefs: readonly string[];
}

export interface WorkflowFinalAttemptReport {
	readonly id: string;
	readonly number: number;
	readonly status: Attempt["status"];
	readonly failure?: Attempt["failure"];
	readonly usage: ResourceUsage;
}

export interface WorkflowFinalReport {
	readonly workflowId: string;
	readonly mode: "direct";
	readonly status: WorkflowTerminalStatus;
	readonly summary: string;
	readonly task: {
		readonly id: string;
		readonly title: string;
		readonly status: Task["status"];
	};
	readonly attempts: readonly WorkflowFinalAttemptReport[];
	readonly changedFiles: readonly string[];
	readonly verifications: readonly VerificationResult[];
	readonly verificationChecks: readonly BasicVerificationCheck[];
	readonly risks: readonly string[];
	readonly unfinishedItems: readonly string[];
	readonly usage: ResourceUsage;
	readonly durationMs: number;
	readonly failureReason?: string;
	readonly lines: readonly string[];
}

export interface BuildWorkflowFinalReportInput {
	readonly workflow: Workflow;
	readonly rootTask: Task;
	readonly attempts: readonly Attempt[];
	readonly verifications: readonly VerificationResult[];
}

const NOT_CONFIGURED_CHECKS: readonly Omit<BasicVerificationCheck, "status">[] = [
	{ kind: "review", label: "Code review" },
	{ kind: "test", label: "Tests" },
	{ kind: "build", label: "Build" },
];

/**
 * Build the M1 basic-verification report for a successful Direct workflow.
 *
 * The report only summarizes what M1 can honestly assert: the files changed by
 * successful `edit`/`write` tool results, and that Review/Test/Build were never
 * configured. It must never claim an unconfigured check passed.
 */
export function buildBasicVerificationReport(
	input: { changedFiles?: readonly string[] } = {},
): BasicVerificationReport {
	const changedFiles = dedupeInOrder(input.changedFiles ?? []);
	const checks: readonly BasicVerificationCheck[] = NOT_CONFIGURED_CHECKS.map((check) => ({
		...check,
		status: "not_configured",
	}));
	const lines = checks.map((check) => `${check.label}: not configured`);
	const evidenceRefs = checks.map((check) => `${check.kind}:not-configured`);
	return { changedFiles, checks, lines, evidenceRefs };
}

/** Build the structured M1 terminal report consumed by the later CLI presentation layer. */
export function buildWorkflowFinalReport(input: BuildWorkflowFinalReportInput): WorkflowFinalReport {
	const { workflow, rootTask } = input;
	if (!isWorkflowTerminalStatus(workflow.status) || !workflow.result) {
		throw new Error(`Workflow ${workflow.id} is not terminal and cannot produce a final report`);
	}
	if (rootTask.workflowId !== workflow.id || workflow.rootTaskId !== rootTask.id) {
		throw new Error(`Task ${rootTask.id} is not the root task of Workflow ${workflow.id}`);
	}
	if (input.attempts.some((attempt) => attempt.workflowId !== workflow.id || attempt.taskId !== rootTask.id)) {
		throw new Error(`Workflow ${workflow.id} report contains an unrelated Attempt`);
	}
	if (input.verifications.some((verification) => verification.workflowId !== workflow.id)) {
		throw new Error(`Workflow ${workflow.id} report contains an unrelated Verification`);
	}

	const verification = buildBasicVerificationReport({
		changedFiles: workflow.result.changedFiles,
	});
	const attempts = input.attempts
		.slice()
		.sort((left, right) => left.number - right.number)
		.map(
			(attempt): WorkflowFinalAttemptReport => ({
				id: attempt.id,
				number: attempt.number,
				status: attempt.status,
				failure: attempt.failure ? structuredClone(attempt.failure) : undefined,
				usage: structuredClone(attempt.usage),
			}),
		);
	const lines = [
		`Workflow: direct | ${workflow.status}`,
		`Task: ${rootTask.status} | ${rootTask.title}`,
		`Attempts: ${attempts.length}`,
		`Changed files: ${verification.changedFiles.length}`,
		...verification.lines,
		...(workflow.result.reason ? [`Failure reason: ${workflow.result.reason}`] : []),
		`Usage: input ${workflow.result.usage.inputTokens} | output ${workflow.result.usage.outputTokens} | turns ${workflow.result.usage.turns} | cost ${workflow.result.usage.cost}`,
		`Duration: ${workflow.result.durationMs}ms`,
	];

	return {
		workflowId: workflow.id,
		mode: "direct",
		status: workflow.result.status,
		summary: workflow.result.summary,
		task: {
			id: rootTask.id,
			title: rootTask.title,
			status: rootTask.status,
		},
		attempts,
		changedFiles: verification.changedFiles,
		verifications: structuredClone(input.verifications),
		verificationChecks: verification.checks,
		risks: structuredClone(workflow.result.risks),
		unfinishedItems: structuredClone(workflow.result.unfinishedItems),
		usage: structuredClone(workflow.result.usage),
		durationMs: workflow.result.durationMs,
		failureReason: workflow.result.reason,
		lines,
	};
}

function dedupeInOrder(paths: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		if (seen.has(path)) {
			continue;
		}
		seen.add(path);
		result.push(path);
	}
	return result;
}
