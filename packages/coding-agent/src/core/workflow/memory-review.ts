import { randomUUID } from "node:crypto";
import type { SessionManager } from "../session-manager.ts";
import { WorkflowController } from "./controller.ts";
import { SessionWorkflowEventLog, SessionWorkflowSnapshotStore } from "./event-log.ts";
import { createWorkflowEventBatch } from "./events.ts";
import { WorkflowStore } from "./stores.ts";
import type { ResourceUsage, Task, Workflow } from "./types.ts";

const REQUIREMENT = "memory-revision-coverage";
const ZERO_USAGE: ResourceUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	durationMs: 0,
};

export interface MemoryReviewItem {
	sourceEntryId: string;
	outcome: "saved" | "unchanged" | "deferred";
	noteIds: string[];
	reason: string;
}

/** Opt-in host coordinator. Reuses Workflow tasks/events; never treats a cut as verification. */
export class MemoryReviewCoordinator {
	private readonly session: SessionManager;

	constructor(session: SessionManager) {
		this.session = session;
	}

	private load() {
		const store = new WorkflowStore();
		const log = new SessionWorkflowEventLog(this.session);
		const controller = new WorkflowController(log, store);
		return { store, log, controller };
	}

	begin(sourceEntryIds: string[]): string {
		const branch = this.session.getBranch();
		if (
			!sourceEntryIds.length ||
			sourceEntryIds.length > 1000 ||
			new Set(sourceEntryIds).size !== sourceEntryIds.length ||
			sourceEntryIds.some(
				(id) =>
					!branch.some((entry) => entry.id === id && entry.type === "message" && entry.message.role === "user"),
			)
		) {
			throw new Error("Memory review requires distinct current-branch user message IDs");
		}
		const { log } = this.load();
		const workflowId = `memory-review-${randomUUID()}`;
		const taskId = `memory-review-task-${randomUUID()}`;
		const occurredAt = new Date().toISOString();
		const metadata = { schemaVersion: 1, revision: 0, createdAt: occurredAt, updatedAt: occurredAt };
		const workflow: Workflow = {
			...metadata,
			id: workflowId,
			status: "received",
			rootTaskId: taskId,
			request: {
				text: JSON.stringify(sourceEntryIds),
				cwd: this.session.getCwd(),
				requestedMode: "direct",
				attachments: [],
			},
			budget: {},
			usage: ZERO_USAGE,
		};
		const task: Task = {
			...metadata,
			id: taskId,
			workflowId,
			kind: "agent",
			accessMode: "read_only",
			title: "Review memory revisions",
			description:
				"Check each scoped user message for confirmations, reversals and amendments; save decisions in Notes, retain unresolved review work here.",
			status: "pending",
			dependencyIds: [],
			budget: {},
			usage: ZERO_USAGE,
			attemptIds: [],
			modifications: [],
			verificationRequirements: [
				{
					id: REQUIREMENT,
					kind: "review",
					description:
						"Agent-reported per-message coverage and validated Note/source links; not independent semantic verification",
					required: true,
				},
			],
		};
		const fields = { occurredAt, actor: { kind: "controller" as const } };
		log.append(
			createWorkflowEventBatch({
				workflowId,
				batchId: randomUUID(),
				commandId: randomUUID(),
				correlationId: workflowId,
				expectedLastSequence: 0,
				events: [
					{
						...fields,
						eventId: randomUUID(),
						entityId: workflowId,
						entityRevision: 0,
						eventType: "workflow.created",
						payload: { workflow },
					},
					{
						...fields,
						eventId: randomUUID(),
						entityId: workflowId,
						entityRevision: 1,
						eventType: "workflow.mode_decided",
						payload: {
							decision: {
								mode: "direct",
								source: "forced_policy",
								reason: "Host memory review",
								riskLevel: "low",
								decidedAt: occurredAt,
							},
						},
					},
					{
						...fields,
						eventId: randomUUID(),
						entityId: taskId,
						entityRevision: 0,
						eventType: "task.created",
						payload: { task },
					},
					{
						...fields,
						eventId: randomUUID(),
						entityId: workflowId,
						entityRevision: 2,
						eventType: "workflow.status_changed",
						payload: {
							fromStatus: "received",
							toStatus: "executing",
							facts: { directModeSelected: true, rootTaskExists: true },
						},
					},
				],
			}),
		);
		// Reload after persistence, following the same event replay path used on resume.
		const current = this.load().controller;
		current.markTaskReady({ commandId: randomUUID(), workflowId, taskId });
		const attemptId = randomUUID();
		current.prepareMainAgentAttempt({
			commandId: randomUUID(),
			workflowId,
			taskId,
			attemptId,
			agentId: "memory-review",
		});
		current.handleRuntimeEvent({ type: "attempt_started", commandId: randomUUID(), workflowId, taskId, attemptId });
		new SessionWorkflowSnapshotStore(this.session).append(current.createSnapshot(workflowId));
		// The coordinator records verification only; Notes writes remain with the main agent.

		return workflowId;
	}

	pending() {
		const { store } = this.load();
		return store
			.listWorkflows()
			.filter(
				(workflow) =>
					workflow.status === "executing" &&
					store
						.listTasks(workflow.id)
						.some((task) => task.verificationRequirements.some((requirement) => requirement.id === REQUIREMENT)),
			)
			.map((workflow) => ({
				workflowId: workflow.id,
				taskId: workflow.rootTaskId!,
				sourceEntryIds: JSON.parse(workflow.request.text) as string[],
			}));
	}

	submit(workflowId: string, items: MemoryReviewItem[]) {
		const review = this.pending().find((item) => item.workflowId === workflowId);
		if (!review) throw new Error("No pending memory review on this branch");
		const ids = items.map((item) => item.sourceEntryId);
		if (
			ids.length !== review.sourceEntryIds.length ||
			new Set(ids).size !== ids.length ||
			review.sourceEntryIds.some((id) => !ids.includes(id))
		) {
			throw new Error(
				`Review must cover every scoped user message exactly once; use deferred for unresolved items. ${JSON.stringify({ workflowId, missingSourceEntryIds: review.sourceEntryIds.filter((id) => !ids.includes(id)), unexpectedSourceEntryIds: ids.filter((id) => !review.sourceEntryIds.includes(id)), duplicateSourceEntryIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))] })}`,
			);
		}
		const notes = this.session.getMemoryNotes();
		const issues: { sourceEntryId: string; noteIds: string[]; problem: string }[] = [];
		for (const item of items) {
			if (!item.reason.trim() || !["saved", "unchanged", "deferred"].includes(item.outcome))
				issues.push({ ...item, problem: "Review requires an outcome and reason" });
			if (item.noteIds.some((id) => !notes.some((note) => note.noteId === id)))
				issues.push({
					sourceEntryId: item.sourceEntryId,
					noteIds: item.noteIds.filter((id) => !notes.some((note) => note.noteId === id)),
					problem: "Review references a missing or archived Note",
				});
			if (
				item.outcome === "saved" &&
				!item.noteIds.some((id) =>
					notes.some((note) => note.noteId === id && note.sourceEntryIds.includes(item.sourceEntryId)),
				)
			)
				issues.push({
					sourceEntryId: item.sourceEntryId,
					noteIds: item.noteIds,
					problem: "Saved revision requires a Note citing its original user message",
				});
		}
		if (issues.length) {
			throw new Error(
				`Memory review rejected; no evidence or completion persisted. ${JSON.stringify({ workflowId, issues })}\nCheck each identified Note body against the original source, preserve existing content and source links when updating, then resubmit the full report. Do not add a citation without supporting content; use deferred with a reason if unresolved.`,
			);
		}
		const evidenceId = this.session.appendCustomEntry("memory-review-evidence", {
			workflowId,
			items,
			noteVersions: items.flatMap((item) =>
				item.noteIds.map((id) => ({ noteId: id, entryId: notes.find((note) => note.noteId === id)!.entryId })),
			),
			assurance: "agent-reported semantics; deterministic coverage and reference validation only",
		});
		const { controller } = this.load();
		const task = controller.getRootTask(workflowId)!;
		const deferred = items.filter((item) => item.outcome === "deferred");
		if (deferred.length) {
			controller.recordContextHandoff({
				commandId: randomUUID(),
				workflowId,
				taskId: task.id,
				description: `Memory review unfinished: ${deferred.length} messages. Read History entry ${evidenceId} for deferred source IDs and reasons; check relevant later history before relying on old unresolved Notes.`,
			});
		} else {
			const verificationId = randomUUID();
			controller.handleRuntimeEvent({
				type: "attempt_succeeded",
				commandId: randomUUID(),
				workflowId,
				taskId: task.id,
				attemptId: task.currentAttemptId!,
				verificationId,
				requirementId: REQUIREMENT,
				usage: ZERO_USAGE,
				summary: "Agent reported full memory review coverage",
				evidenceRefs: [evidenceId],
			});
			controller.complete({
				commandId: randomUUID(),
				workflowId,
				taskId: task.id,
				verificationId,
				summary: "Coverage and Note/source links validated; semantic judgments are agent-reported",
				changedFiles: [],
				evidenceRefs: [evidenceId],
				risks: ["No independent semantic completeness proof"],
				usage: ZERO_USAGE,
				durationMs: 0,
			});
		}
		new SessionWorkflowSnapshotStore(this.session).append(controller.createSnapshot(workflowId));
		return { completed: deferred.length === 0, evidenceId, deferred: deferred.map((item) => item.sourceEntryId) };
	}

	projection(): string {
		const pending = this.pending();
		if (!pending.length) return "";
		const index = pending
			.slice(-5)
			.map(({ workflowId, taskId, sourceEntryIds }) => ({ workflowId, taskId, sourceCount: sourceEntryIds.length }));
		return `Unfinished Workflow memory reviews: ${pending.length} total (a context cut does not complete them). Recent index: ${JSON.stringify(index)}\nFor relevant final/current decisions, review these sources and subsequent related History before treating an old pending/unconfirmed Note as final. Use memory_review status for all pending scopes and source IDs. Notes hold decisions; Workflow holds review progress.`;
	}
}
