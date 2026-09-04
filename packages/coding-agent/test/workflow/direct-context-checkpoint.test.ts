import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	startDirectAgentSessionWorkflow,
	WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
	type WorkflowAgentSession,
	WriterLeaseRegistry,
} from "../../src/core/workflow/index.ts";

class FakeAgentSession implements WorkflowAgentSession {
	readonly sessionManager = SessionManager.inMemory("C:/repo");
	readonly #listeners = new Set<AgentSessionEventListener>();

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async abort(): Promise<void> {}

	async waitForIdle(): Promise<void> {}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

function start(session: FakeAgentSession) {
	let nextId = 0;
	return startDirectAgentSessionWorkflow(
		session,
		{
			commandId: "start-direct-context",
			workflowId: "workflow-direct-context",
			rootTaskId: "task-direct-context",
			request: { text: "Capture Direct context", cwd: "C:/repo", attachments: [] },
		},
		{
			createId: (kind) => `${kind}-${++nextId}`,
			now: () => 100,
			writerLeaseRegistry: new WriterLeaseRegistry(),
		},
	);
}

describe("AgentSessionAdapter context checkpoint", () => {
	it("persists and returns the latest authoritative Direct Workflow Snapshot", () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		session.emit({ type: "agent_start" });

		const checkpoint = adapter.checkpointForContextWindow();
		const persisted = session.sessionManager.getEntry(checkpoint.snapshotEntryId);

		expect(checkpoint.workflowId).toBe("workflow-direct-context");
		expect(persisted).toMatchObject({
			type: "custom",
			customType: WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
			data: checkpoint.snapshot,
		});
		expect(checkpoint.snapshot.workflow).toMatchObject({
			id: "workflow-direct-context",
			status: "executing",
		});
		expect(checkpoint.snapshot.tasks).toEqual([
			expect.objectContaining({
				id: "task-direct-context",
				status: "running",
				currentAttemptId: "attempt-2",
			}),
		]);
		expect(checkpoint.snapshot.attempts).toEqual([
			expect.objectContaining({
				id: "attempt-2",
				status: "running",
				taskId: "task-direct-context",
			}),
		]);
		if (persisted?.type !== "custom") throw new Error("Expected a persisted Workflow Snapshot");
		expect(persisted.data).not.toBe(checkpoint.snapshot);

		adapter.dispose();
	});

	it("does not return a checkpoint when Snapshot persistence fails", () => {
		const session = new FakeAgentSession();
		const adapter = start(session);
		const append = vi.spyOn(session.sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("snapshot write failed");
		});

		expect(() => adapter.checkpointForContextWindow()).toThrow("snapshot write failed");
		expect(append).toHaveBeenCalledWith(WORKFLOW_SNAPSHOT_CUSTOM_TYPE, expect.any(Object));

		adapter.dispose();
	});
});
