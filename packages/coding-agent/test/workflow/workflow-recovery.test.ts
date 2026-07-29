import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	type PlanContent,
	SessionWorkflowEventLog,
	SessionWorkflowSnapshotStore,
	WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
	WorkflowController,
	WorkflowStore,
	WriterLeaseRegistry,
} from "../../src/index.ts";

function content(): PlanContent {
	return {
		goal: "Recover active resources",
		assumptions: [],
		steps: [
			{
				id: "agent",
				title: "Inspect",
				description: "Inspect",
				dependsOn: [],
				fileIntents: [],
				verificationRequirementIds: ["manual"],
			},
			{
				id: "job",
				kind: "command",
				command: "npm run check",
				title: "Check",
				description: "Check",
				dependsOn: [],
				fileIntents: [],
				verificationRequirementIds: ["manual"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "manual",
				kind: "manual",
				description: "Completed",
				required: true,
			},
		],
	};
}

function createController(session: SessionManager): WorkflowController {
	let sequence = 0;
	return new WorkflowController(new SessionWorkflowEventLog(session), new WorkflowStore(), {
		createId: (kind) => `${kind}-${++sequence}`,
		now: () => "2026-07-27T00:00:00.000Z",
	});
}

describe("Workflow Snapshot and recovery", () => {
	it("rejects malformed persisted Snapshots instead of silently skipping them", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(WORKFLOW_SNAPSHOT_CUSTOM_TYPE, {
			schemaVersion: 1,
			workflowId: "workflow-invalid",
		});

		expect(() => new SessionWorkflowSnapshotStore(session).readLatest()).toThrow(
			"Cannot recover an invalid Workflow Snapshot",
		);
	});

	it("restores a Snapshot and applies only later Events", () => {
		const session = SessionManager.inMemory();
		const controller = createController(session);
		controller.startPlan({
			commandId: "start",
			workflowId: "workflow-1",
			rootTaskId: "root",
			planId: "plan",
			request: { text: "Recover", cwd: "C:/repo", attachments: [] },
		});
		controller.submitPlanForApproval({
			commandId: "submit",
			workflowId: "workflow-1",
			planId: "plan",
			content: content(),
			plannerReadOnly: true,
		});
		controller.approvePlan({
			commandId: "approve",
			workflowId: "workflow-1",
			planId: "plan",
			comment: "Approved",
		});
		controller.refreshTaskReadiness({ commandId: "ready", workflowId: "workflow-1" });
		const snapshot = controller.createSnapshot("workflow-1");
		new SessionWorkflowSnapshotStore(session).append(snapshot);
		const agentTask = controller.listTasks("workflow-1").find(({ sourcePlanStepId }) => sourcePlanStepId === "agent");
		if (!agentTask) throw new Error("Expected Agent Task");
		controller.prepareTaskAttempt({
			commandId: "prepare",
			workflowId: "workflow-1",
			taskId: agentTask.id,
			attemptId: "attempt-agent",
			assignment: { executorKind: "subagent", agentId: "agent-1" },
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "started",
			workflowId: "workflow-1",
			taskId: agentTask.id,
			attemptId: "attempt-agent",
		});

		const restored = new WorkflowController(new SessionWorkflowEventLog(session), new WorkflowStore(), {
			snapshot,
		});
		expect(restored.getTask(agentTask.id)?.status).toBe("running");
		expect(restored.listAttempts(agentTask.id)[0]?.status).toBe("running");
	});

	it("rejects a Snapshot whose event history does not match its sequence", () => {
		const session = SessionManager.inMemory();
		const controller = createController(session);
		controller.startPlan({
			commandId: "start",
			workflowId: "workflow-invalid-history",
			rootTaskId: "root",
			planId: "plan",
			request: { text: "Recover", cwd: "C:/repo", attachments: [] },
		});
		const snapshot = controller.createSnapshot("workflow-invalid-history");

		expect(
			() =>
				new WorkflowController(new SessionWorkflowEventLog(session), new WorkflowStore(), {
					snapshot: { ...snapshot, eventIds: [] },
				}),
		).toThrow("Workflow Snapshot event history is invalid");
	});

	it("marks uncertain Agent and Job Attempts interrupted and makes their Tasks retryable", () => {
		const session = SessionManager.inMemory();
		const controller = createController(session);
		controller.startPlan({
			commandId: "start",
			workflowId: "workflow-2",
			rootTaskId: "root",
			planId: "plan",
			budget: { maxRetries: 0 },
			request: { text: "Recover", cwd: "C:/repo", attachments: [] },
		});
		controller.submitPlanForApproval({
			commandId: "submit",
			workflowId: "workflow-2",
			planId: "plan",
			content: content(),
			plannerReadOnly: true,
		});
		controller.approvePlan({
			commandId: "approve",
			workflowId: "workflow-2",
			planId: "plan",
			comment: "Approved",
		});
		controller.refreshTaskReadiness({ commandId: "ready", workflowId: "workflow-2" });
		const tasks = controller.listTasks("workflow-2");
		const agentTask = tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "agent");
		const jobTask = tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "job");
		if (!agentTask || !jobTask) throw new Error("Expected executable Tasks");
		controller.prepareTaskAttempt({
			commandId: "prepare-agent",
			workflowId: "workflow-2",
			taskId: agentTask.id,
			attemptId: "attempt-agent",
			assignment: { executorKind: "subagent", agentId: "agent-1" },
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "start-agent",
			workflowId: "workflow-2",
			taskId: agentTask.id,
			attemptId: "attempt-agent",
		});
		controller.prepareTaskAttempt({
			commandId: "prepare-job",
			workflowId: "workflow-2",
			taskId: jobTask.id,
			attemptId: "attempt-job",
			assignment: { executorKind: "job", jobId: "job-1" },
			writerLeaseId: "lease-1",
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "start-job",
			workflowId: "workflow-2",
			taskId: jobTask.id,
			attemptId: "attempt-job",
		});
		const snapshot = controller.createSnapshot("workflow-2");
		const recovered = new WorkflowController(new SessionWorkflowEventLog(session), new WorkflowStore(), {
			snapshot,
		});
		recovered.recoverInterrupted({
			commandId: "recover",
			workflowId: "workflow-2",
			reason: "Restarted",
		});

		expect(recovered.listAttempts(agentTask.id)[0]).toMatchObject({
			status: "interrupted",
			agentId: "agent-1",
		});
		expect(recovered.listAttempts(jobTask.id)[0]).toMatchObject({
			status: "interrupted",
			jobId: "job-1",
		});
		expect(recovered.getTask(agentTask.id)?.status).toBe("ready");
		expect(recovered.getTask(jobTask.id)?.status).toBe("ready");
		recovered.prepareTaskAttempt({
			commandId: "prepare-recovery",
			workflowId: "workflow-2",
			taskId: agentTask.id,
			attemptId: "attempt-agent-recovery",
			assignment: { executorKind: "subagent", agentId: "agent-2" },
			recoveryOfAttemptId: "attempt-agent",
			recoveryReason: "Restarted",
		});
		expect(recovered.listAttempts(agentTask.id)[1]).toMatchObject({
			id: "attempt-agent-recovery",
			number: 2,
			status: "queued",
			recoveryOfAttemptId: "attempt-agent",
			recoveryReason: "Restarted",
		});
	});

	it("releases only a recovered Workflow's stale Writer Lease", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-recovered-lease-"));
		try {
			const owner = new WriterLeaseRegistry({ storageDirectory: directory });
			const recovery = new WriterLeaseRegistry({ storageDirectory: directory });
			owner.acquire({
				workspace: "C:/repo",
				workflowId: "workflow-1",
				taskId: "task-1",
				attemptId: "attempt-1",
				ttlMs: 60_000,
			});

			expect(recovery.releaseRecovered("other-workflow", "C:/repo")).toBe(false);
			expect(recovery.releaseRecovered("workflow-1", "C:/repo")).toBe(true);
			expect(recovery.get("C:/repo")).toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
