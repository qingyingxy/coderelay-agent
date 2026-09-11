import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyReviewBoundary } from "../../src/core/delivery/review-boundary.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { parseHandoff } from "../../src/core/subagents/handoff.ts";
import {
	DeliveryRuntime,
	DiffCollector,
	type JobProcess,
	type JobProcessExit,
	type JobProcessFactory,
	JobRuntime,
	ModelGateway,
	PlanWorkflowRuntime,
	type ReadonlyReviewer,
	type ReviewResult,
	type StartJobProcessInput,
	SubagentReadonlyReviewer,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { spawnProcessSync } from "../../src/utils/child-process.ts";
import { ZERO_USAGE } from "./fixtures.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "./subagent-fixtures.ts";

class SequencedProcess implements JobProcess {
	readonly pid: number;
	readonly #input: StartJobProcessInput;
	readonly #exitCode: number;

	constructor(pid: number, input: StartJobProcessInput, exitCode: number) {
		this.pid = pid;
		this.#input = input;
		this.#exitCode = exitCode;
	}

	async wait(): Promise<JobProcessExit> {
		this.#input.onStdout(`exit ${this.#exitCode}\n`);
		return { exitCode: this.#exitCode };
	}

	async terminate(): Promise<void> {}
}

class SequencedFactory implements JobProcessFactory {
	readonly #exitCodes: number[];
	#sequence = 0;

	constructor(exitCodes: number[]) {
		this.#exitCodes = exitCodes;
	}

	start(input: StartJobProcessInput): JobProcess {
		const index = this.#sequence++;
		return new SequencedProcess(7000 + index, input, this.#exitCodes[index] ?? 0);
	}
}

class PassingReviewer implements ReadonlyReviewer {
	calls = 0;

	async review(): Promise<ReviewResult> {
		this.calls++;
		return {
			status: "passed",
			summary: "Review passed",
			evidenceRefs: ["src/index.ts:1"],
			risks: [],
			unfinishedItems: [],
		};
	}
}

class ThrowingReviewer implements ReadonlyReviewer {
	async review(): Promise<ReviewResult> {
		throw new Error("Reviewer transport stopped");
	}
}

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function routingGateway(): ModelGateway {
	const models = [model("test", "balanced"), model("test", "strong")];
	return new ModelGateway(
		{
			getModel: (provider, id) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
			hasConfiguredAuth: () => true,
		},
		{
			enabled: true,
			balancedModel: "test/balanced",
			strongModel: "test/strong",
		},
	);
}

function createPlan(
	id: string,
	includeReview = false,
	maxRetries = 1,
	includeReviewerTask = false,
	timing: { readonly maxDurationMs?: number; readonly now?: () => string } = {},
): PlanWorkflowRuntime {
	const runtime = PlanWorkflowRuntime.start(
		SessionManager.inMemory(),
		{
			workflowId: `workflow-${id}`,
			rootTaskId: `root-${id}`,
			planId: `plan-${id}`,
			budget: {
				maxRetries,
				maxConcurrentAgents: 1,
				maxConcurrentJobs: 1,
				...(timing.maxDurationMs === undefined ? {} : { maxDurationMs: timing.maxDurationMs }),
			},
			request: {
				text: "Implement and verify",
				cwd: `C:/delivery-${id}-${Date.now()}`,
				attachments: [],
			},
		},
		timing.now ? { now: timing.now } : {},
	);
	runtime.submit({
		goal: "Implement and verify",
		assumptions: [],
		steps: [
			{
				id: "implement",
				kind: "command",
				command: "implement",
				title: "Implement",
				description: "Apply a deterministic change",
				dependsOn: [],
				fileIntents: [
					{ path: "src/fix.ts", action: "create", reason: "Simulated implementation and repair output" },
				],
				verificationRequirementIds: ["implementation"],
			},
			...(includeReviewerTask
				? [
						{
							id: "review-task",
							kind: "agent" as const,
							requiredAgentRole: "reviewer" as const,
							title: "Review the implementation",
							description: "Review the implementation before delivery",
							dependsOn: ["implement"],
							fileIntents: [],
							verificationRequirementIds: ["review"],
						},
					]
				: []),
		],
		risks: [],
		verificationRequirements: [
			{
				id: "implementation",
				kind: "manual",
				description: "Implementation command completed",
				required: true,
			},
			...(includeReview
				? [
						{
							id: "review",
							kind: "review" as const,
							description: "Readonly review passes",
							required: true,
						},
					]
				: []),
			{
				id: "tests",
				kind: "test",
				description: "Tests pass",
				command: "test",
				required: true,
			},
		],
	});
	runtime.approve();
	return runtime;
}

function createAgentVerifiedPlan(id: string, includeSecondaryWorkerRequirement = false): PlanWorkflowRuntime {
	const runtime = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: `workflow-${id}`,
		rootTaskId: `root-${id}`,
		planId: `plan-${id}`,
		budget: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentJobs: 1 },
		request: {
			text: "Implement with Agent evidence and verify",
			cwd: `C:/delivery-${id}-${Date.now()}`,
			attachments: [],
		},
	});
	runtime.submit({
		goal: "Implement with Agent evidence and verify",
		assumptions: [],
		steps: [
			{
				id: "implement",
				kind: "agent",
				requiredAgentRole: "worker",
				title: "Implement",
				description: "Apply the implementation",
				dependsOn: [],
				fileIntents: [
					{
						path: "src/index.ts",
						action: "modify",
						reason: "Implement the change",
					},
				],
				verificationRequirementIds: [
					"worker-evidence",
					...(includeSecondaryWorkerRequirement ? ["worker-secondary-evidence"] : []),
				],
			},
			{
				id: "verify",
				kind: "command",
				command: "test",
				title: "Verify",
				description: "Run deterministic verification",
				dependsOn: ["implement"],
				fileIntents: [],
				verificationRequirementIds: ["final-tests"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "worker-evidence",
				kind: "test",
				description: "Worker verifies the implementation result",
				required: true,
			},
			...(includeSecondaryWorkerRequirement
				? [
						{
							id: "worker-secondary-evidence",
							kind: "manual" as const,
							description: "Worker verifies the secondary implementation invariant",
							required: true,
						},
					]
				: []),
			{
				id: "final-tests",
				kind: "test",
				description: "Tests pass",
				command: "test",
				required: true,
			},
		],
	});
	runtime.approve();
	return runtime;
}

describe("DeliveryRuntime", () => {
	it.each([
		"missing",
		"malformed",
		"unknown-requirement",
		"invented-quote",
		"no-evidence",
		"unrelated-file",
		"mixed",
		"valid-request",
	])("validates finding evidence and requirement anchors: %s", (variant) => {
		const plan = createPlan(`boundary-${variant}`, true);
		const finding = {
			category: "must_fix",
			basis: "requirement",
			introducedByChange: false,
			summary: "Acceptance failure",
			evidence: ["src/index.ts:1 concrete failure"],
			requirementId: variant === "valid-request" ? "$request" : "implementation",
			requirementQuote: variant === "valid-request" ? "Implement and verify" : "Implementation command completed",
		};
		if (variant === "unknown-requirement") finding.requirementId = "new-unapproved-requirement";
		if (variant === "invented-quote") finding.requirementQuote = "Validate all subscribers";
		if (variant === "no-evidence") finding.evidence = [];
		if (variant === "unrelated-file") finding.evidence = ["unrelated.ts:1 unrelated finding"];
		const findings =
			variant === "mixed" ? [finding, { ...finding, category: "confirmation", basis: "ambiguity" }] : [finding];
		const handoff = parseHandoff(
			subagentHandoff({
				verificationSummary: [
					"review:failed",
					...(variant === "missing"
						? []
						: [`review_findings:${variant === "malformed" ? "{" : JSON.stringify(findings)}`]),
				],
			}),
			{
				id: "handoff-boundary",
				agentId: "reviewer",
				workflowId: plan.workflow.id,
				taskId: plan.workflow.rootTaskId!,
				attemptId: "review-attempt",
				createdAt: new Date().toISOString(),
			},
		);
		const result = applyReviewBoundary(
			{
				workflow: plan.workflow,
				rootTask: plan.tasks.find((task) => task.id === plan.workflow.rootTaskId)!,
				acceptanceRequirements: plan.currentPlan.verificationRequirements,
				diff: { files: [], changedFiles: ["src/index.ts"], summary: "Scoped change", evidenceRefs: [] },
			},
			{ status: "failed", summary: "Review failed", evidenceRefs: [], risks: [], unfinishedItems: [], handoff },
		);
		expect(result.failureKind).toBe(
			variant === "valid-request" ? "finding" : variant === "unrelated-file" ? "infrastructure" : "confirmation",
		);
	});

	it.each([
		{ category: "suggestion", basis: "hardening", introducedByChange: false, expected: "completed" },
		{ category: "must_fix", basis: "requirement", introducedByChange: false, expected: "repair_created" },
		{ category: "must_fix", basis: "regression", introducedByChange: true, expected: "repair_created" },
		{ category: "must_fix", basis: "regression", introducedByChange: false, expected: "failed" },
		{ category: "must_fix", basis: "hardening", introducedByChange: false, expected: "failed" },
		{ category: "confirmation", basis: "ambiguity", introducedByChange: false, expected: "failed" },
		{ category: "suggestion", basis: "safety", introducedByChange: false, expected: "failed" },
	])("enforces review boundary: $category/$basis/$introducedByChange", async (finding) => {
		const plan = createPlan(`boundary-${finding.category}-${finding.basis}-${finding.introducedByChange}`, true);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const collector = new DiffCollector();
		vi.spyOn(collector, "collect").mockReturnValue({
			files: [],
			changedFiles: ["src/index.ts"],
			summary: "one changed file",
			evidenceRefs: [],
		});
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			reviewer: new SubagentReadonlyReviewer(subagents),
			diffCollector: collector,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		try {
			const pending = delivery.run(plan);
			await vi.waitFor(() => expect(sessions.sessions[0]?.promptCalls).toHaveLength(1));
			expect(sessions.sessions[0]?.promptCalls[0]).toContain('"description":"Implementation command completed"');
			expect(sessions.sessions[0]?.promptCalls[0]).toContain("Repairs do not expand that scope");
			sessions.sessions[0]!.complete(
				subagentHandoff({
					verificationSummary: [
						"review:failed",
						`review_findings:${JSON.stringify([
							{
								category: finding.category,
								basis: finding.basis,
								introducedByChange: finding.introducedByChange,
								summary: "Counter boundary finding",
								evidence: ["src/index.ts:1 before committed; after mutates on failure"],
								requirementId: "implementation",
								requirementQuote: "Implementation command completed",
							},
						])}`,
					],
					unfinishedItems: ["Do not blindly forward this unclassified repair instruction"],
				}),
			);
			const result = await pending;
			expect(result.status).toBe(finding.expected);
			expect(plan.tasks.filter((task) => task.kind === "repair")).toHaveLength(
				finding.expected === "repair_created" ? 1 : 0,
			);
			if (finding.expected === "completed") {
				expect(result.risks.join(" ")).toContain("Counter boundary finding");
				expect(result.unfinishedItems).toEqual([]);
			} else if (finding.expected === "failed") {
				expect(plan.workflow.result?.reason).toContain("Review requires confirmation:");
			}
		} finally {
			await subagents.dispose();
		}
	});

	it("classifies a repeatedly missing Reviewer verdict as infrastructure failure", async () => {
		const plan = createPlan("reviewer-verdict-invalid", true);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const reviewer = new SubagentReadonlyReviewer(subagents);
		const rootTask = plan.tasks.find(({ id }) => id === plan.workflow.rootTaskId)!;
		const review = reviewer.review({
			workflow: plan.workflow,
			rootTask,
			diff: {
				files: [],
				changedFiles: [],
				summary: "Review this change",
				evidenceRefs: [],
			},
		});

		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(1));
		sessions.sessions[0]?.complete(subagentHandoff({ verificationSummary: ["change inspected"] }));
		await vi.waitFor(() => expect(sessions.sessions[0]?.promptCalls).toHaveLength(2));
		sessions.sessions[0]?.complete(subagentHandoff({ verificationSummary: ["still no verdict"] }));
		await expect(review).resolves.toMatchObject({
			status: "failed",
			failureKind: "infrastructure",
			summary: "Reviewer returned no explicit review verdict after one correction",
		});
		await subagents.dispose();
	});

	it("repairs a missing Reviewer verdict once in the original Session", async () => {
		const plan = createPlan("reviewer-verdict-repair", true);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const reviewer = new SubagentReadonlyReviewer(subagents);
		const rootTask = plan.tasks.find(({ id }) => id === plan.workflow.rootTaskId)!;
		const review = reviewer.review({
			workflow: plan.workflow,
			rootTask,
			diff: {
				files: [],
				changedFiles: [],
				summary: "Review this change",
				evidenceRefs: [],
			},
		});

		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(1));
		sessions.sessions[0]?.complete(subagentHandoff({ verificationSummary: ["change inspected"] }));
		await vi.waitFor(() => expect(sessions.sessions[0]?.promptCalls).toHaveLength(2));
		expect(sessions.sessions[0]?.promptCalls[1]).toContain("missing an explicit verdict");
		sessions.sessions[0]?.complete(subagentHandoff({ verificationSummary: ["review:passed"] }));
		await expect(review).resolves.toMatchObject({ status: "passed" });
		expect(sessions.sessions).toHaveLength(1);
		await subagents.dispose();
	});

	it("retries an incomplete Reviewer once on the balanced tier", async () => {
		const plan = createPlan("reviewer-runtime-retry", true);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: routingGateway(),
		});
		const reviewer = new SubagentReadonlyReviewer(subagents);
		const rootTask = plan.tasks.find(({ id }) => id === plan.workflow.rootTaskId)!;
		const review = reviewer.review({
			workflow: plan.workflow,
			rootTask,
			diff: {
				files: [],
				changedFiles: [],
				summary: "Review this change",
				evidenceRefs: [],
			},
		});

		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(1));
		sessions.sessions[0]?.fail(new Error("Timeout waiting for agent to become idle"));
		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(2));
		expect(subagents.list(plan.workflow.id)[1]?.modelRoute).toMatchObject({
			tier: "balanced",
			reasonCode: "model.retry_role_tier",
		});
		sessions.sessions[1]?.complete(subagentHandoff({ verificationSummary: ["review:passed"] }));
		await expect(review).resolves.toMatchObject({ status: "passed" });
		await subagents.dispose();
	});

	it("accepts a Reviewer verdict embedded in a concise verification sentence", async () => {
		const plan = createPlan("embedded-review", true);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: routingGateway(),
		});
		const reviewer = new SubagentReadonlyReviewer(subagents);
		const rootTask = plan.tasks.find(({ id }) => id === plan.workflow.rootTaskId)!;
		const highRiskWorkflow = {
			...plan.workflow,
			modeDecision: {
				mode: "plan" as const,
				source: "agent" as const,
				reason: "High-risk change",
				riskLevel: "high" as const,
				decidedAt: "2026-08-10T00:00:00.000Z",
			},
		};

		const review = reviewer.review({
			workflow: highRiskWorkflow,
			rootTask,
			diff: {
				files: [],
				changedFiles: [],
				summary: "No risky changes",
				evidenceRefs: [],
			},
		});
		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(1));
		expect(sessions.sessions[0]?.promptCalls[0]).toContain("Do not explore unrelated repository files");
		expect(subagents.list(plan.workflow.id)[0]?.modelRoute).toMatchObject({
			tier: "strong",
			reasonCode: "model.reviewer.high_risk_strong",
		});
		sessions.sessions[0]?.complete(
			subagentHandoff({
				verificationSummary: ["review:passed - diff is correct"],
			}),
		);

		await expect(review).resolves.toMatchObject({ status: "passed" });
		await subagents.dispose();
	});

	it("keeps a failed Reviewer retry on the balanced role tier", async () => {
		const plan = createPlan("reviewer-escalation", true);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: routingGateway(),
		});
		const reviewer = new SubagentReadonlyReviewer(subagents);
		const rootTask = plan.tasks.find(({ id }) => id === plan.workflow.rootTaskId)!;
		const input = {
			workflow: plan.workflow,
			rootTask,
			diff: {
				files: [],
				changedFiles: [],
				summary: "Review this change",
				evidenceRefs: [],
			},
		};

		const firstReview = reviewer.review(input);
		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(1));
		expect(subagents.list(plan.workflow.id)[0]?.modelRoute?.tier).toBe("balanced");
		sessions.sessions[0]?.complete(
			subagentHandoff({
				verificationSummary: ["review:failed - actionable defect found"],
			}),
		);
		await expect(firstReview).resolves.toMatchObject({ status: "failed" });

		const secondReview = reviewer.review(input);
		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(2));
		expect(subagents.list(plan.workflow.id)[1]?.modelRoute).toMatchObject({
			tier: "balanced",
			modelName: "test/balanced",
			reasonCode: "model.retry_role_tier",
		});
		sessions.sessions[1]?.complete(subagentHandoff({ verificationSummary: ["review:passed"] }));
		await expect(secondReview).resolves.toMatchObject({ status: "passed" });
		await subagents.dispose();
	});

	it("rejects a negated Reviewer pass token", async () => {
		const plan = createPlan("negated-review", true);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const reviewer = new SubagentReadonlyReviewer(subagents);
		const rootTask = plan.tasks.find(({ id }) => id === plan.workflow.rootTaskId)!;

		const review = reviewer.review({
			workflow: plan.workflow,
			rootTask,
			diff: {
				files: [],
				changedFiles: [],
				summary: "No risky changes",
				evidenceRefs: [],
			},
		});
		await vi.waitFor(() => expect(sessions.sessions).toHaveLength(1));
		sessions.sessions[0]?.complete(
			subagentHandoff({
				verificationSummary: ["review:failed - not review:passed"],
			}),
		);

		await expect(review).resolves.toMatchObject({ status: "failed" });
		await subagents.dispose();
	});

	it("runs Diff, readonly Review, and Test before passing the Completion Gate", async () => {
		const plan = createPlan("complete", true);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			reviewer: new PassingReviewer(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const result = await delivery.run(plan);

		expect(result.status).toBe("completed");
		expect(plan.workflow.status).toBe("completed");
		expect(plan.verifications).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ requirementId: "review", status: "passed" }),
				expect.objectContaining({
					requirementId: "tests",
					status: "passed",
					command: "test",
				}),
			]),
		);
		expect(plan.finalReport?.lines.join("\n")).toContain("Verifications:");
	});

	it("reuses successful Task evidence for a requirement without a separate command", async () => {
		const plan = createAgentVerifiedPlan("agent-evidence");
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			verificationRunner: async () => ({
				exitCode: 0,
				output: "test passed",
				timedOut: false,
			}),
		});
		const [implementation] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[0]?.emit({
			type: "tool_execution_start",
			toolCallId: "worker-test",
			toolName: "bash",
			args: { command: "test" },
		});
		sessions.sessions[0]?.emit({
			type: "tool_execution_end",
			toolCallId: "worker-test",
			toolName: "bash",
			isError: false,
			result: "test passed",
		});
		sessions.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Implementation completed",
				changedFiles: ["src/index.ts"],
				verificationSummary: ["Implementation behavior verified"],
			}),
		);
		await implementation?.completion;

		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [verification] = await plan.startReadyJobs(jobs, 1);
		await verification?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const result = await delivery.run(plan);

		expect(result.status).toBe("completed");
		expect(plan.workflow.status).toBe("completed");
		expect(plan.verifications.filter(({ requirementId }) => requirementId === "worker-evidence")).toEqual([
			expect.objectContaining({
				status: "passed",
				taskId: implementation?.agent.taskId,
			}),
		]);
		await subagents.dispose();
	});

	it("records successful Handoff evidence for every no-command requirement owned by one Agent Task", async () => {
		const plan = createAgentVerifiedPlan("multiple-agent-evidence", true);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			verificationRunner: async () => ({
				exitCode: 0,
				output: "test passed",
				timedOut: false,
			}),
		});
		const [implementation] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[0]?.emit({
			type: "tool_execution_start",
			toolCallId: "worker-test",
			toolName: "bash",
			args: { command: "test" },
		});
		sessions.sessions[0]?.emit({
			type: "tool_execution_end",
			toolCallId: "worker-test",
			toolName: "bash",
			isError: false,
			result: "test passed",
		});
		sessions.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Both implementation invariants verified",
				changedFiles: ["src/index.ts"],
				verificationSummary: ["Primary and secondary behavior verified"],
			}),
		);
		await implementation?.completion;

		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [verification] = await plan.startReadyJobs(jobs, 1);
		await verification?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const result = await delivery.run(plan);

		expect(result.status).toBe("completed");
		expect(plan.verifications).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					requirementId: "worker-evidence",
					status: "passed",
				}),
				expect.objectContaining({
					requirementId: "worker-secondary-evidence",
					status: "passed",
				}),
			]),
		);
		await subagents.dispose();
	});

	it("reuses a successful Reviewer Task instead of spawning a duplicate delivery Reviewer", async () => {
		const plan = createPlan("review-task", true, 1, true);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;

		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const [reviewTask] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Review passed",
				verificationSummary: ["review:passed"],
			}),
		);
		await reviewTask?.completion;

		const reviewer = new PassingReviewer();
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			reviewer,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const result = await delivery.run(plan);

		expect(result.status).toBe("completed");
		expect(reviewer.calls).toBe(0);
		await subagents.dispose();
	});

	it("runs a fresh delivery Review after Repair instead of reusing a stale Reviewer Task", async () => {
		const plan = createPlan("review-after-repair", true, 1, true);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 1, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;

		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const [reviewTask] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Review passed",
				verificationSummary: ["review:passed"],
			}),
		);
		await reviewTask?.completion;

		const reviewer = new PassingReviewer();
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			reviewer,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const failed = await delivery.run(plan);
		expect(failed.status).toBe("repair_created");
		expect(reviewer.calls).toBe(0);

		const [repair] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[1]?.complete(
			subagentHandoff({
				conclusion: "Repair completed",
				changedFiles: ["src/fix.ts"],
				verificationSummary: ["Repair applied"],
			}),
		);
		await repair?.completion;

		const completed = await delivery.run(plan);
		expect(completed.status).toBe("completed");
		expect(reviewer.calls).toBe(1);
		await subagents.dispose();
	});

	it("creates a bounded Repair Task after Test failure and completes after re-verification", async () => {
		const plan = createPlan("repair");
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 1, 0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const failed = await delivery.run(plan);
		expect(failed).toMatchObject({
			status: "repair_created",
			repairTask: { kind: "repair", repairIteration: 1 },
		});
		expect(plan.workflow.status).toBe("executing");

		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: routingGateway(),
		});
		const [repair] = await plan.startReadySubagents(subagents, 1);
		expect(repair?.agent.modelRoute).toMatchObject({
			tier: "strong",
			modelName: "test/strong",
			reasonCode: "model.verification_failure_escalated_strong",
		});
		sessions.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Repair completed",
				changedFiles: ["src/fix.ts"],
				verificationSummary: ["Repair applied"],
			}),
			{ ...ZERO_USAGE, turns: 1 },
		);
		await repair?.completion;

		const completed = await delivery.run(plan);
		expect(completed.status).toBe("completed");
		expect(plan.workflow.status).toBe("completed");
		expect(plan.tasks.filter(({ kind }) => kind === "repair")).toHaveLength(1);
		expect(
			plan.verifications.filter(({ requirementId }) => requirementId === "tests").map(({ status }) => status),
		).toEqual(["failed", "passed"]);
	});

	it("starts Repair with the actual remaining workflow budget", async () => {
		const createdAt = new Date(Date.now() - 414_000).toISOString();
		const plan = createPlan("repair-remaining-budget", false, 1, false, {
			maxDurationMs: 600_000,
			now: () => createdAt,
		});
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 1]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		await expect(delivery.run(plan)).resolves.toMatchObject({
			status: "repair_created",
		});
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			modelGateway: routingGateway(),
		});
		const [repair] = await plan.startReadySubagents(subagents, 1);
		expect(repair?.agent.modelRoute?.tier).toBe("strong");
		expect(repair?.agent.budget.maxDurationMs).toBeGreaterThan(90_000);
		expect(repair?.agent.budget.maxDurationMs).toBeLessThanOrEqual(130_000);
		await subagents.interrupt(repair!.agent.id, "Budget regression verified");
		await repair?.completion;
		await subagents.dispose();
	});
	it("records Reviewer runtime errors as failed Verification instead of abandoning the Workflow", async () => {
		const plan = createPlan("review-error", true);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			reviewer: new ThrowingReviewer(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const result = await delivery.run(plan);

		expect(result.status).toBe("failed");
		expect(plan.tasks.filter(({ kind }) => kind === "repair")).toHaveLength(0);
		expect(plan.verifications).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					requirementId: "review",
					status: "failed",
					summary: "Readonly Reviewer failed: Reviewer transport stopped",
				}),
			]),
		);
	});

	it("fails terminally when the Repair budget is exhausted", async () => {
		const plan = createPlan("repair-limit", false, 0);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 1]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});

		const result = await delivery.run(plan);

		expect(result.status).toBe("failed");
		expect(plan.workflow.status).toBe("failed");
		expect(plan.workflow.result?.reason).toContain("Repair limit 0 reached");
	});

	it("stops when a successful Repair produces no file changes", async () => {
		const plan = createPlan("repair-no-change", false, 2);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 1, 1]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		await delivery.run(plan);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const [repair] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[0]?.complete(subagentHandoff({ conclusion: "No change was needed" }));
		await repair?.completion;

		const result = await delivery.run(plan);

		expect(result.status).toBe("failed");
		expect(plan.workflow.result?.reason).toContain("produced no file changes");
		expect(plan.tasks.filter(({ kind }) => kind === "repair")).toHaveLength(1);
	});

	it("stops when verification repeats the same failure after Repair", async () => {
		const plan = createPlan("repair-repeat", false, 2);
		const jobs = new JobRuntime({
			processFactory: new SequencedFactory([0, 1, 1]),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const [implementation] = await plan.startReadyJobs(jobs, 1);
		await implementation?.completion;
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		await delivery.run(plan);
		const sessions = new FakeSubagentSessionFactory();
		const subagents = new SubagentRuntime({
			sessionFactory: sessions,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
		});
		const [repair] = await plan.startReadySubagents(subagents, 1);
		sessions.sessions[0]?.complete(
			subagentHandoff({
				conclusion: "Repair changed the implementation",
				changedFiles: ["src/fix.ts"],
			}),
		);
		await repair?.completion;

		const result = await delivery.run(plan);

		expect(result.status).toBe("failed");
		expect(plan.workflow.result?.reason).toContain("repeated the same failure");
		expect(plan.tasks.filter(({ kind }) => kind === "repair")).toHaveLength(1);
	});
});

describe("DiffCollector", () => {
	it("collects only Workflow-owned changes with Task, Attempt, and Agent ownership", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-delivery-diff-"));
		try {
			spawnProcessSync("git", ["init"], {
				cwd,
				encoding: "utf8",
				windowsHide: true,
			});
			spawnProcessSync("git", ["config", "user.email", "test@example.com"], {
				cwd,
				encoding: "utf8",
				windowsHide: true,
			});
			spawnProcessSync("git", ["config", "user.name", "Test"], {
				cwd,
				encoding: "utf8",
				windowsHide: true,
			});
			writeFileSync(join(cwd, "owned.txt"), "before\n");
			writeFileSync(join(cwd, "unrelated.txt"), "before\n");
			spawnProcessSync("git", ["add", "owned.txt", "unrelated.txt"], {
				cwd,
				encoding: "utf8",
				windowsHide: true,
			});
			spawnProcessSync("git", ["commit", "-m", "base"], {
				cwd,
				encoding: "utf8",
				windowsHide: true,
			});
			writeFileSync(join(cwd, "owned.txt"), "after\n");
			writeFileSync(join(cwd, "unrelated.txt"), "user change\n");
			const task = {
				schemaVersion: 1,
				revision: 1,
				createdAt: "2026-07-27T00:00:00.000Z",
				updatedAt: "2026-07-27T00:00:00.000Z",
				id: "task-1",
				workflowId: "workflow-1",
				kind: "agent" as const,
				accessMode: "writer" as const,
				title: "Change owned file",
				description: "Change owned file",
				status: "succeeded" as const,
				dependencyIds: [],
				assignment: { executorKind: "subagent" as const, agentId: "agent-1" },
				budget: {},
				usage: ZERO_USAGE,
				attemptIds: ["attempt-1"],
				currentAttemptId: "attempt-1",
				verificationRequirements: [],
				modifications: [
					{
						path: "owned.txt",
						operation: "edit" as const,
						workflowId: "workflow-1",
						taskId: "task-1",
						attemptId: "attempt-1",
						agentId: "agent-1",
						toolCallId: "tool-1",
						recordedAt: "2026-07-27T00:00:00.000Z",
					},
				],
				result: {
					summary: "done",
					changedFiles: ["owned.txt"],
					verificationIds: [],
					completedAt: "2026-07-27T00:00:00.000Z",
				},
			};

			const diff = new DiffCollector().collect(cwd, [task]);

			expect(diff.changedFiles).toEqual(["owned.txt"]);
			expect(diff.files[0]?.patch).toContain("-before");
			expect(diff.files[0]?.patch).toContain("+after");
			expect(diff.files[0]?.owners[0]).toMatchObject({
				taskId: "task-1",
				attemptId: "attempt-1",
				agentId: "agent-1",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
