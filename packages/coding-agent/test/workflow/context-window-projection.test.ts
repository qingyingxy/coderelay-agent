import { describe, expect, it } from "vitest";
import {
	MIN_WORKFLOW_CONTEXT_PROJECTION_MAX_BYTES,
	projectWorkflowSnapshot,
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

describe("projectWorkflowSnapshot", () => {
	it("projects authoritative continuation fields without serializing the whole snapshot", () => {
		const projection = projectWorkflowSnapshot(createSnapshot());

		expect(projection).toMatchObject({
			schemaVersion: 1,
			workflowId: "workflow-1",
			snapshotSequence: 4,
			truncated: false,
		});
		expect(projection.content).toContain("Workflow: id=workflow-1 mode=plan status=executing sequence=4");
		expect(projection.content).toContain("Current plan: id=plan-2 version=2 status=approved");
		expect(projection.content).toContain("Task task-a:");
		expect(projection.content).toContain("Attempt attempt-1:");
		expect(projection.content).toContain("Verification verification-1:");
		expect(projection.content).toContain("Next action: Continue Task task-a: First task");
		expect(projection.content).toContain("History: use the history tool");
		expect(projection.content).not.toContain("event-1");
		expect(projection.byteLength).toBe(Buffer.byteLength(projection.content, "utf8"));
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
		expect(projection.content).toContain("Next action: Continue Task task-00");
		expect(projection.content).toContain("History: use the history tool");
	});

	it("rejects invalid byte limits and mismatched workflow ids", () => {
		expect(() => projectWorkflowSnapshot(createSnapshot(), 100)).toThrow("maxBytes");
		expect(() => projectWorkflowSnapshot({ ...createSnapshot(), workflowId: "other" })).toThrow("does not match");
	});
});
