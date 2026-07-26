import { describe, expect, it } from "vitest";
import { buildBasicVerificationReport, buildWorkflowFinalReport } from "../../src/core/workflow/report.ts";
import type { Attempt, ResourceUsage, Task, VerificationResult, Workflow } from "../../src/core/workflow/types.ts";

const USAGE: ResourceUsage = {
	inputTokens: 20,
	outputTokens: 10,
	cacheReadTokens: 5,
	cacheWriteTokens: 2,
	cost: 0.03,
	turns: 2,
	durationMs: 50,
};

function createTerminalReportInput(status: "completed" | "failed" | "cancelled") {
	const workflowId = "workflow-1";
	const taskId = "task-1";
	const verificationId = "verification-1";
	const workflow: Workflow = {
		schemaVersion: 1,
		revision: 4,
		createdAt: "2026-07-26T00:00:00.000Z",
		updatedAt: "2026-07-26T00:00:01.000Z",
		id: workflowId,
		status,
		request: {
			text: "Implement a CLI change",
			cwd: "C:/repo",
			attachments: [],
		},
		modeDecision: {
			mode: "direct",
			source: "default",
			reason: "M1 Direct",
			riskLevel: "low",
			decidedAt: "2026-07-26T00:00:00.000Z",
		},
		rootTaskId: taskId,
		budget: {},
		usage: USAGE,
		result: {
			status,
			summary: status === "completed" ? "Implemented" : `Workflow ${status}`,
			completedTaskIds: status === "completed" ? [taskId] : [],
			failedTaskIds: status === "failed" ? [taskId] : [],
			changedFiles: status === "completed" ? ["src/a.ts"] : [],
			verificationIds: status === "completed" ? [verificationId] : [],
			risks: [],
			unfinishedItems: status === "completed" ? [] : [`Workflow ${status}`],
			usage: USAGE,
			durationMs: USAGE.durationMs,
			reason: status === "completed" ? undefined : `Workflow ${status}`,
		},
	};
	const task: Task = {
		schemaVersion: 1,
		revision: 4,
		createdAt: "2026-07-26T00:00:00.000Z",
		updatedAt: "2026-07-26T00:00:01.000Z",
		id: taskId,
		workflowId,
		kind: "agent",
		title: "Direct request",
		description: "Implement a CLI change",
		status: status === "completed" ? "succeeded" : status === "failed" ? "failed" : "cancelled",
		dependencyIds: [],
		budget: {},
		usage: USAGE,
		attemptIds: ["attempt-1"],
		currentAttemptId: "attempt-1",
		verificationRequirements: [],
	};
	const attempt: Attempt = {
		schemaVersion: 1,
		revision: 2,
		createdAt: "2026-07-26T00:00:00.000Z",
		updatedAt: "2026-07-26T00:00:01.000Z",
		id: "attempt-1",
		workflowId,
		taskId,
		number: 1,
		status: status === "completed" ? "succeeded" : status === "failed" ? "failed" : "cancelled",
		executorKind: "main_agent",
		usage: USAGE,
	};
	const verification: VerificationResult = {
		id: verificationId,
		workflowId,
		taskId,
		requirementId: "agent-session-complete",
		status: "passed",
		summary: "Implemented",
		evidenceRefs: ["review:not-configured", "test:not-configured", "build:not-configured"],
		startedAt: "2026-07-26T00:00:00.000Z",
		endedAt: "2026-07-26T00:00:01.000Z",
	};
	return {
		workflow,
		rootTask: task,
		attempts: [attempt],
		verifications: status === "completed" ? [verification] : [],
	};
}

describe("buildBasicVerificationReport", () => {
	it("reports Review/Test/Build as not configured without claiming success", () => {
		const report = buildBasicVerificationReport();

		expect(report.lines).toEqual(["Code review: not configured", "Tests: not configured", "Build: not configured"]);
		expect(report.evidenceRefs).toEqual(["review:not-configured", "test:not-configured", "build:not-configured"]);
		expect(report.checks.every((check) => check.status === "not_configured")).toBe(true);
		expect(report.lines.some((line) => /pass|passed|通过/i.test(line))).toBe(false);
	});

	it("dedupes changed files while preserving first-seen order", () => {
		const report = buildBasicVerificationReport({
			changedFiles: ["src/b.ts", "src/a.ts", "src/b.ts"],
		});

		expect(report.changedFiles).toEqual(["src/b.ts", "src/a.ts"]);
	});

	it("defaults to an empty changed-file set", () => {
		expect(buildBasicVerificationReport().changedFiles).toEqual([]);
	});

	it("builds a structured terminal report with all M1 delivery fields", () => {
		const report = buildWorkflowFinalReport(createTerminalReportInput("completed"));

		expect(report).toMatchObject({
			workflowId: "workflow-1",
			mode: "direct",
			status: "completed",
			task: {
				status: "succeeded",
			},
			changedFiles: ["src/a.ts"],
			usage: USAGE,
			durationMs: 50,
		});
		expect(report.attempts).toHaveLength(1);
		expect(report.verifications).toHaveLength(1);
		expect(report.lines).toContain("Tests: not configured");
		expect(report.lines.some((line) => line.startsWith("Usage:"))).toBe(true);
	});

	it("includes the terminal failure reason without inventing verification success", () => {
		const report = buildWorkflowFinalReport(createTerminalReportInput("failed"));

		expect(report.failureReason).toBe("Workflow failed");
		expect(report.verifications).toEqual([]);
		expect(report.lines).toContain("Failure reason: Workflow failed");
		expect(report.verificationChecks.every((check) => check.status === "not_configured")).toBe(true);
	});

	it("rejects a non-terminal Workflow", () => {
		const input = createTerminalReportInput("completed");
		const workflow: Workflow = {
			...input.workflow,
			status: "executing",
			result: undefined,
		};

		expect(() => buildWorkflowFinalReport({ ...input, workflow })).toThrow("is not terminal");
	});
});
