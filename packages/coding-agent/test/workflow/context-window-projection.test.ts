import { describe, expect, it } from "vitest";
import {
	MIN_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES,
	projectWorkflowSnapshot,
	selectRecentWorkflowSnapshots,
} from "../../src/core/workflow/context-window-projection.ts";
import type { WorkflowSnapshot } from "../../src/core/workflow/stores.ts";
import type {
	Attempt,
	Plan,
	ResourceUsage,
	Task,
	VerificationResult,
	Workflow,
} from "../../src/core/workflow/types.ts";

const timestamp = "2025-01-01T00:00:00.000Z";
const usage: ResourceUsage = {
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0.01,
	turns: 1,
	durationMs: 100,
};
const metadata = { schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp } as const;

function createSnapshot(): WorkflowSnapshot {
	const workflow: Workflow = {
		...metadata,
		id: "workflow-1",
		status: "executing",
		request: { text: "Implement hard context windows", cwd: "/repo", attachments: [] },
		modeDecision: {
			mode: "plan",
			source: "user",
			reason: "Explicit request",
			riskLevel: "medium",
			decidedAt: timestamp,
		},
		currentPlanId: "plan-2",
		budget: { maxInputTokens: 100_000, maxTurns: 20 },
		usage,
	};
	const plan: Plan = {
		...metadata,
		id: "plan-2",
		workflowId: workflow.id,
		version: 2,
		status: "approved",
		goal: "Add recoverable hard cuts",
		assumptions: ["Session JSONL remains authoritative", "Summary mode stays default"],
		steps: [],
		risks: [],
		verificationRequirements: [],
		decisionHistory: [],
	};
	const tasks: Task[] = [
		{
			...metadata,
			id: "task-b",
			workflowId: workflow.id,
			kind: "agent",
			accessMode: "writer",
			title: "Second task",
			description: "later",
			status: "ready",
			dependencyIds: ["task-a"],
			budget: {},
			usage,
			attemptIds: [],
			verificationRequirements: [],
			modifications: [],
		},
		{
			...metadata,
			id: "task-a",
			workflowId: workflow.id,
			kind: "agent",
			accessMode: "writer",
			title: "First task",
			description: "now",
			status: "running",
			dependencyIds: [],
			budget: {},
			usage,
			attemptIds: ["attempt-1"],
			currentAttemptId: "attempt-1",
			verificationRequirements: [],
			modifications: [],
		},
	];
	const attempt: Attempt = {
		...metadata,
		id: "attempt-1",
		workflowId: workflow.id,
		taskId: "task-a",
		number: 1,
		status: "running",
		executorKind: "main_agent",
		usage,
	};
	const verification: VerificationResult = {
		id: "verification-1",
		workflowId: workflow.id,
		taskId: "task-a",
		requirementId: "tests",
		status: "not_started",
		summary: "Run focused tests",
		evidenceRefs: ["test-b", "test-a"],
	};
	return {
		schemaVersion: 1,
		workflowId: workflow.id,
		lastSequence: 4,
		workflow,
		plans: [plan],
		tasks,
		attempts: [attempt],
		verifications: [{ revision: 1, result: verification }],
		processedCommands: [],
		eventIds: ["event-1", "event-2", "event-3", "event-4"],
		createdAt: timestamp,
	};
}

function createCompletedSnapshot(
	id: string,
	updatedAt: string,
	objective: string,
	summary: string,
	changedFiles: readonly string[] = [],
	unfinishedItems: readonly string[] = [],
): WorkflowSnapshot {
	const base = createSnapshot();
	return {
		...base,
		workflowId: id,
		workflow: {
			...base.workflow,
			id,
			status: "completed",
			request: { ...base.workflow.request, text: objective },
			updatedAt,
			result: {
				status: "completed",
				summary,
				completedTaskIds: [],
				failedTaskIds: [],
				changedFiles,
				verificationIds: [],
				risks: [],
				unfinishedItems,
				usage,
				durationMs: usage.durationMs,
			},
		},
	};
}

describe("projectWorkflowSnapshot", () => {
	it("projects authoritative continuation fields without serializing the whole snapshot", () => {
		const projection = projectWorkflowSnapshot(createSnapshot());

		expect(projection).toMatchObject({
			schemaVersion: 1,
			workflowId: "workflow-1",
			snapshotSequence: 4,
			truncated: false,
		});
		expect(projection.content).toContain("Internal workflow_* IDs are control-plane IDs");
		expect(projection.content).toContain("Workflow: workflow_id=workflow-1 mode=plan status=executing sequence=4");
		expect(projection.content).toContain("Plan: workflow_plan_id=plan-2 version=2 status=approved");
		expect(projection.content).toContain("Workflow Task: workflow_task_id=task-a");
		expect(projection.content).toContain("Workflow Attempt: workflow_attempt_id=attempt-1 workflow_task_id=task-a");
		expect(projection.content).toContain(
			"Workflow Verification: workflow_verification_id=verification-1 workflow_task_id=task-a",
		);
		expect(projection.content).toContain("Next action: Continue workflow_task_id=task-a: First task");
		expect(projection.content).toContain("Workspace/diff is current-code authority");
		expect(projection.content).toContain("Use Workspace/diff for current code");
		expect(projection.content).toContain("Notes for durable design semantics");
		expect(projection.content).toContain("History only when exact unavailable prior evidence is required");
		expect(projection.content).not.toContain("event-1");
		expect(projection.byteLength).toBe(Buffer.byteLength(projection.content, "utf8"));
	});

	it("namespaces internal identifiers so they cannot be mistaken for user-domain identifiers", () => {
		const projection = projectWorkflowSnapshot(createSnapshot());

		expect(projection.content).toContain("workflow_id=workflow-1");
		expect(projection.content).toContain("workflow_plan_id=plan-2");
		expect(projection.content).toContain("workflow_task_id=task-a");
		expect(projection.content).toContain("workflow_attempt_id=attempt-1");
		expect(projection.content).toContain("workflow_verification_id=verification-1");
		expect(projection.content).not.toMatch(/(?:^|\s)(?:id|task_id|attempt_id|verification_id)=/m);
	});

	it("is deterministic when unordered entity arrays change order", () => {
		const first = createSnapshot();
		const second: WorkflowSnapshot = {
			...first,
			tasks: [...first.tasks].reverse(),
			attempts: [...first.attempts].reverse(),
			verifications: [...first.verifications].reverse(),
		};

		expect(projectWorkflowSnapshot(second)).toEqual(projectWorkflowSnapshot(first));
	});

	it("selects the three most recently updated completed Workflows deterministically", () => {
		const snapshots = [
			createCompletedSnapshot("workflow-old", "2025-01-02T00:00:00.000Z", "Old objective", "Old result"),
			createCompletedSnapshot("workflow-current", "2025-01-05T00:00:00.000Z", "Current", "Current result"),
			createCompletedSnapshot("workflow-b", "2025-01-04T00:00:00.000Z", "Second", "Second result"),
			createCompletedSnapshot("workflow-a", "2025-01-04T00:00:00.000Z", "First", "First result"),
			createCompletedSnapshot("workflow-new", "2025-01-06T00:00:00.000Z", "Newest", "Newest result"),
		];
		const incomplete = createSnapshot();
		const all = [incomplete, ...snapshots];
		const source = {
			listWorkflows: () => all.map(({ workflow }) => workflow),
			createSnapshot: (workflowId: string) => {
				const snapshot = all.find((candidate) => candidate.workflowId === workflowId);
				if (!snapshot) throw new Error(`Missing test Workflow ${workflowId}`);
				return snapshot;
			},
		};

		expect(selectRecentWorkflowSnapshots(source, "workflow-current").map(({ workflowId }) => workflowId)).toEqual([
			"workflow-new",
			"workflow-b",
			"workflow-a",
		]);
		expect(selectRecentWorkflowSnapshots(source, "workflow-current", 0)).toEqual([]);
		expect(() => selectRecentWorkflowSnapshots(source, "workflow-current", -1)).toThrow("non-negative");
	});

	it("projects prior Workflow objectives and outcomes without requiring memory retrieval", () => {
		const recent = [
			createCompletedSnapshot(
				"workflow-stage-2",
				"2025-01-03T00:00:00.000Z",
				"Preserve the backend transport contract and keep retry metadata stable",
				"Transport contract preserved and focused checks passed",
				["src/backend.ts", "src/transport.ts"],
				["Run the platform-specific smoke check"],
			),
			createCompletedSnapshot(
				"workflow-stage-1",
				"2025-01-02T00:00:00.000Z",
				"Add the original import contract",
				"Import contract implemented",
			),
		];

		const projection = projectWorkflowSnapshot(createSnapshot(), undefined, recent);

		expect(projection.content).toContain("Recent Workflow Context: workflow_id=workflow-stage-2");
		expect(projection.content).toContain("Preserve the backend transport contract");
		expect(projection.content).toContain("Transport contract preserved and focused checks passed");
		expect(projection.content).toContain('changed_files=["src/backend.ts","src/transport.ts"]');
		expect(projection.content).toContain('unfinished=["Run the platform-specific smoke check"]');
		expect(projection.content).toContain("Recent Workflow Context: workflow_id=workflow-stage-1");
		expect(projection.content.indexOf("workflow-stage-2")).toBeLessThan(
			projection.content.indexOf("workflow-stage-1"),
		);
		expect(projection.content).toContain("Notes for durable design semantics");
	});

	it("retains the start and continuation instruction of a long objective", () => {
		const base = createSnapshot();
		const objective = `Controlled boundary 1. ${"archive-padding ".repeat(18)}PRESERVE_MIDDLE_CONSTRAINT ${"archive-padding ".repeat(80)}After the context switch, reply exactly WINDOW_1_READY.`;
		const projection = projectWorkflowSnapshot({
			...base,
			workflow: {
				...base.workflow,
				request: { ...base.workflow.request, text: objective },
			},
		});

		expect(projection.content).toContain("Current objective: Controlled boundary 1.");
		expect(projection.content).toContain("PRESERVE_MIDDLE_CONSTRAINT");
		expect(projection.content).toContain("After the context switch, reply exactly WINDOW_1_READY.");
		expect(projection.content).not.toContain(objective);
	});

	it("truncates optional details while retaining authority and retrieval guidance", () => {
		const base = createSnapshot();
		const tasks = Array.from(
			{ length: 30 },
			(_, index): Task => ({
				...base.tasks[1],
				id: `task-${String(index).padStart(2, "0")}`,
				title: `Task ${index} ${"detail ".repeat(80)}`,
				status: index === 0 ? "running" : "pending",
				attemptIds: [],
				currentAttemptId: undefined,
			}),
		);
		const projection = projectWorkflowSnapshot(
			{ ...base, tasks, attempts: [], verifications: [] },
			MIN_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES,
		);

		expect(projection.truncated).toBe(true);
		expect(projection.byteLength).toBeLessThanOrEqual(MIN_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES);
		expect(projection.content).toContain("[projection truncated: omitted");
		expect(projection.content).toContain("Next action: Continue workflow_task_id=task-00");
		expect(projection.content).toContain("Use Workspace/diff for current code");
	});

	it("rejects invalid byte limits and mismatched workflow ids", () => {
		expect(() => projectWorkflowSnapshot(createSnapshot(), 100)).toThrow("maxBytes");
		expect(() => projectWorkflowSnapshot({ ...createSnapshot(), workflowId: "other" })).toThrow("does not match");
	});

	it("keeps unresolved verification ahead of completed work under a bounded seed", () => {
		const base = createSnapshot();
		const snapshot: WorkflowSnapshot = {
			...base,
			tasks: Array.from({ length: 20 }, (_, index) => ({
				...base.tasks[0],
				id: `done-${index}`,
				status: "succeeded" as const,
			})),
			verifications: [
				{
					revision: 1,
					result: { ...base.verifications[0].result, id: "a-passed", status: "passed", summary: "Insert passed" },
				},
				{
					revision: 1,
					result: {
						...base.verifications[0].result,
						id: "z-upsert",
						status: "failed",
						summary: "Upsert savepoint lost",
					},
				},
			],
		};
		const projection = projectWorkflowSnapshot(snapshot, 1800);
		expect(projection.truncated).toBe(true);
		expect(projection.content).toContain("Upsert savepoint lost");
		expect(projection.content).not.toContain("a-passed");
		expect(projection.content).toContain("Current objective:");
		expect(projection.content).toContain("Constraints:");
		expect(projection.content.indexOf("Next action:")).toBeLessThan(projection.content.indexOf("z-upsert"));
		expect(projection.byteLength).toBeLessThanOrEqual(1800);
	});

	it("shows declared checks with no results without treating runtime success as coverage", () => {
		const base = createSnapshot();
		const projection = projectWorkflowSnapshot({
			...base,
			tasks: [
				{
					...base.tasks[0],
					verificationRequirements: [
						{ id: "tracing", kind: "test", required: true, description: "SQL tracing regression" },
					],
				},
			],
		});
		expect(projection.content).toContain(
			"Not checked: workflow_task_id=task-b requirement=tracing SQL tracing regression",
		);
		expect(projection.content).toContain("changed code and runtime success do not establish test coverage");
	});

	it("keeps failed and unchecked requirements ahead of observed modification details", () => {
		const base = createSnapshot();
		const snapshot: WorkflowSnapshot = {
			...base,
			workflow: {
				...base.workflow,
				rootTaskId: "task-a",
				modeDecision: { ...base.workflow.modeDecision!, mode: "direct" },
			},
			tasks: [
				{
					...base.tasks[1],
					verificationRequirements: [
						{ id: "rollback", kind: "test", required: true, description: "Verify upsert rollback" },
					],
					modifications: Array.from({ length: 30 }, (_, index) => ({
						path: `src/long-path-${index}-${"detail-".repeat(30)}.ts`,
						operation: "edit" as const,
						workflowId: "workflow-1",
						taskId: "task-a",
						attemptId: "attempt-1",
						agentId: "main",
						toolCallId: `tool-${index}`,
						recordedAt: timestamp,
					})),
				},
			],
			verifications: [
				{
					revision: 1,
					result: { ...base.verifications[0].result, status: "failed", summary: "Upsert savepoint lost" },
				},
			],
		};
		const projection = projectWorkflowSnapshot(snapshot, 1800);
		expect(projection.truncated).toBe(true);
		expect(projection.byteLength).toBeLessThanOrEqual(1800);
		expect(projection.content).toContain("Upsert savepoint lost");
		expect(projection.content).toContain("Not checked: workflow_task_id=task-a requirement=rollback");
		const full = projectWorkflowSnapshot(snapshot);
		expect(full.content).toContain('Observed modification: path="src/long-path-0-');
	});

	it("projects host-observed file changes with their Task and Attempt while keeping Workspace authoritative", () => {
		const base = createSnapshot();
		const snapshot: WorkflowSnapshot = {
			...base,
			tasks: base.tasks.map((task) =>
				task.id === "task-a"
					? {
							...task,
							modifications: [
								{
									path: "src/importer.ts",
									operation: "edit",
									workflowId: "workflow-1",
									taskId: "task-a",
									attemptId: "attempt-1",
									agentId: "main",
									toolCallId: "tool-edit",
									recordedAt: timestamp,
								},
							],
						}
					: task,
			),
		};
		const projection = projectWorkflowSnapshot(snapshot);
		expect(projection.content).toContain(
			'Observed modification: path="src/importer.ts" operation=edit workflow_task_id=task-a workflow_attempt_id=attempt-1',
		);
		expect(projection.content).toContain("may be incomplete");
		expect(projection.content).toContain("Use Workspace/diff for current code");
	});

	it("keeps only the latest observed modification for each Task path", () => {
		const base = createSnapshot();
		const snapshot: WorkflowSnapshot = {
			...base,
			tasks: base.tasks.map((task) =>
				task.id === "task-a"
					? {
							...task,
							modifications: [
								{
									path: "src/importer.ts",
									operation: "edit",
									workflowId: "workflow-1",
									taskId: "task-a",
									attemptId: "attempt-1",
									agentId: "main",
									toolCallId: "tool-old",
									recordedAt: "2025-01-01T00:00:00.000Z",
								},
								{
									path: "src/importer.ts",
									operation: "write",
									workflowId: "workflow-1",
									taskId: "task-a",
									attemptId: "attempt-1",
									agentId: "main",
									toolCallId: "tool-new",
									recordedAt: "2025-01-02T00:00:00.000Z",
								},
							],
						}
					: task,
			),
		};

		const matchingLines = projectWorkflowSnapshot(snapshot)
			.content.split("\n")
			.filter((line) => line.includes('Observed modification: path="src/importer.ts"'));
		expect(matchingLines).toEqual([
			expect.stringContaining("operation=write workflow_task_id=task-a workflow_attempt_id=attempt-1"),
		]);
	});

	it("projects deterministic one-shot verification receipts ahead of memory retrieval", () => {
		const base = createSnapshot();
		const snapshot: WorkflowSnapshot = {
			...base,
			tasks: base.tasks.map((task) =>
				task.id === "task-a"
					? {
							...task,
							operationReceipts: [
								{
									workflowId: "workflow-1",
									taskId: "task-a",
									attemptId: "attempt-1",
									toolCallId: "live-verify-1",
									toolName: "live_verify",
									kind: "verification",
									status: "succeeded",
									inputSummary: '{"contract":"base"}',
									resultSummary: "Acceptance passed: 11/11",
									recordedAt: timestamp,
								},
							],
						}
					: task,
			),
		};
		const projection = projectWorkflowSnapshot(snapshot);
		expect(projection.content).toContain(
			'Workflow Operation Receipt: kind=verification tool=live_verify status=succeeded input="{\\"contract\\":\\"base\\"}"',
		);
		expect(projection.content).toContain("tool_call_id=live-verify-1");
		expect(projection.content).toContain("trust Workflow Operation Receipts");
		expect(projection.content).toContain("do not repeat a receipt-bearing call solely to rediscover its result");
	});

	it.each(["plan", "task"] as const)("does not suggest finalizing with an unchecked %s requirement", (scope) => {
		const base = createSnapshot();
		const requirement = {
			id: "rollback",
			kind: "test" as const,
			required: true,
			description: "Verify upsert rollback",
		};
		const snapshot: WorkflowSnapshot = {
			...base,
			workflow: { ...base.workflow, status: "verifying" },
			plans: base.plans.map((plan) => ({
				...plan,
				verificationRequirements: scope === "plan" ? [requirement] : [],
			})),
			tasks: [{ ...base.tasks[1], verificationRequirements: scope === "task" ? [requirement] : [] }],
			verifications: [
				{
					revision: 1,
					result: { ...base.verifications[0].result, status: "passed", summary: "Existing suite passed" },
				},
			],
		};
		const projection = projectWorkflowSnapshot(snapshot);
		expect(projection.content).toContain("Next action: Complete unchecked verification");
		expect(projection.content).not.toContain("finalize the workflow");
		const checked = projectWorkflowSnapshot({
			...snapshot,
			verifications: [
				...snapshot.verifications,
				{
					revision: 1,
					result: {
						...base.verifications[0].result,
						id: "rollback-result",
						taskId: scope === "task" ? "task-a" : undefined,
						requirementId: requirement.id,
						status: "passed",
						summary: "Targeted rollback test passed",
					},
				},
			],
		});
		expect(checked.content).toContain("Next action: Reconcile verification results and finalize the workflow.");
	});

	it("does not suggest finalizing a verifying workflow with failed checks", () => {
		const base = createSnapshot();
		const projection = projectWorkflowSnapshot({
			...base,
			workflow: { ...base.workflow, status: "verifying" },
			verifications: [
				{ revision: 1, result: { ...base.verifications[0].result, status: "failed", summary: "Repair upsert" } },
			],
		});
		expect(projection.content).toContain(
			"Next action: Continue workflow_verification_id=verification-1: Repair upsert",
		);
		expect(projection.content).not.toContain("finalize the workflow");
	});
});
