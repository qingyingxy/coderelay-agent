import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { WorkflowController } from "../../src/core/workflow/controller.ts";
import { SessionWorkflowEventLog } from "../../src/core/workflow/event-log.ts";
import { validateWorkflowEvent } from "../../src/core/workflow/events.ts";
import { WorkflowStore } from "../../src/core/workflow/stores.ts";

describe("Direct handoff storage validation", () => {
	it("keeps the previous brief on rejection and validates replayed events with the same byte limit", () => {
		const manager = SessionManager.inMemory();
		const log = new SessionWorkflowEventLog(manager);
		const controller = new WorkflowController(log, new WorkflowStore());
		controller.startDirect({
			commandId: "start",
			workflowId: "workflow",
			rootTaskId: "task",
			request: { text: "Original unresolved task", cwd: ".", attachments: [] },
		});
		controller.markTaskReady({ commandId: "ready", workflowId: "workflow", taskId: "task" });
		controller.prepareMainAgentAttempt({
			commandId: "prepare",
			workflowId: "workflow",
			taskId: "task",
			attemptId: "attempt",
			writerLeaseId: "lease",
		});
		controller.handleRuntimeEvent({
			type: "attempt_started",
			commandId: "running",
			workflowId: "workflow",
			taskId: "task",
			attemptId: "attempt",
		});
		const before = manager.getEntries().length;
		for (const description of ["中".repeat(1334), "a".repeat(4001), " ", `${"a".repeat(4000)} `]) {
			expect(() =>
				controller.recordContextHandoff({
					commandId: "rejected",
					workflowId: "workflow",
					taskId: "task",
					description,
				}),
			).toThrow("UTF-8 bytes");
			expect(controller.getTask("task")?.description).toBe("Original unresolved task");
			expect(manager.getEntries()).toHaveLength(before);
		}
		const description = `${"中".repeat(1333)}a`;
		controller.recordContextHandoff({ commandId: "accepted", workflowId: "workflow", taskId: "task", description });
		expect(controller.getTask("task")?.description).toBe(description);
		const event = log
			.read()
			.flatMap(({ batch }) => batch.events)
			.find((item) => item.eventType === "task.description_updated");
		if (!event || event.eventType !== "task.description_updated") throw new Error("Missing handoff event");
		expect(validateWorkflowEvent(event)).toEqual([]);
		for (const invalid of ["中".repeat(1334), "a".repeat(4001), " "]) {
			expect(validateWorkflowEvent({ ...event, payload: { description: invalid } })).toEqual([
				expect.objectContaining({ code: "event.invalid_task_description" }),
			]);
		}
	});
});
