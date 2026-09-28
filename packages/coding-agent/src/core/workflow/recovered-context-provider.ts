import type { SessionManager } from "../session-manager.ts";
import {
	selectRecentWorkflowSnapshots,
	type WorkflowContextCheckpoint,
	type WorkflowContextProvider,
} from "./context-window-projection.ts";
import { WorkflowController } from "./controller.ts";
import { SessionWorkflowEventLog, SessionWorkflowSnapshotStore } from "./event-log.ts";
import { WorkflowStore } from "./stores.ts";
import { isWorkflowTerminalStatus } from "./transitions.ts";

class RecoveredDirectWorkflowContextProvider implements WorkflowContextProvider {
	readonly #sessionManager: SessionManager;
	readonly #controller: WorkflowController;
	readonly #workflowId: string;

	constructor(sessionManager: SessionManager, controller: WorkflowController, workflowId: string) {
		this.#sessionManager = sessionManager;
		this.#controller = controller;
		this.#workflowId = workflowId;
	}

	get isTerminal(): boolean {
		const workflow = this.#controller.getWorkflow(this.#workflowId);
		return workflow !== undefined && isWorkflowTerminalStatus(workflow.status);
	}

	checkpointForContextWindow(): WorkflowContextCheckpoint {
		const snapshot = this.#controller.createSnapshot(this.#workflowId);
		const snapshotEntryId = new SessionWorkflowSnapshotStore(this.#sessionManager).append(snapshot);
		return {
			workflowId: this.#workflowId,
			snapshotEntryId,
			snapshot,
			recentWorkflowSnapshots: selectRecentWorkflowSnapshots(this.#controller, this.#workflowId),
		};
	}
}

export function recoverLatestDirectWorkflowContextProvider(
	sessionManager: SessionManager,
): WorkflowContextProvider | undefined {
	const eventLog = new SessionWorkflowEventLog(sessionManager);
	const latestBatch = eventLog.read().at(-1);
	if (!latestBatch) return undefined;

	const branch = sessionManager.getBranch();
	const latestBatchIndex = branch.findIndex(({ id }) => id === latestBatch.sessionEntryId);
	let latestUserIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "user") {
			latestUserIndex = index;
			break;
		}
	}
	if (latestUserIndex > latestBatchIndex) return undefined;

	const controller = new WorkflowController(eventLog, new WorkflowStore());
	const workflow = controller.getWorkflow(latestBatch.batch.workflowId);
	if (workflow?.modeDecision?.mode !== "direct") return undefined;

	return new RecoveredDirectWorkflowContextProvider(sessionManager, controller, workflow.id);
}
