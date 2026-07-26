import type { TaskId, WorkflowId } from "./types.ts";

export type WorkflowRuntimeResourceKind = "agent" | "job";

export interface WorkflowRuntimeResource {
	readonly id: string;
	readonly kind: WorkflowRuntimeResourceKind;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	stop(reason: string): Promise<void>;
}

export interface RuntimeCancellationResult {
	readonly stoppedResourceIds: readonly string[];
	readonly failures: readonly { id: string; message: string }[];
}

export class WorkflowRuntimeRegistry {
	readonly #resources = new Map<string, WorkflowRuntimeResource>();

	register(resource: WorkflowRuntimeResource): () => void {
		if (this.#resources.has(resource.id)) {
			throw new Error(`Runtime resource ${resource.id} already exists`);
		}
		this.#resources.set(resource.id, resource);
		return () => {
			this.#resources.delete(resource.id);
		};
	}

	list(workflowId?: WorkflowId): readonly WorkflowRuntimeResource[] {
		return [...this.#resources.values()].filter(
			(resource) => workflowId === undefined || resource.workflowId === workflowId,
		);
	}

	async cancelWorkflow(workflowId: WorkflowId, reason: string): Promise<RuntimeCancellationResult> {
		const resources = this.list(workflowId);
		const settled = await Promise.allSettled(resources.map((resource) => resource.stop(reason)));
		const stoppedResourceIds: string[] = [];
		const failures: { id: string; message: string }[] = [];
		for (const [index, result] of settled.entries()) {
			const resource = resources[index];
			if (!resource) {
				continue;
			}
			if (result.status === "fulfilled") {
				stoppedResourceIds.push(resource.id);
				this.#resources.delete(resource.id);
			} else {
				failures.push({
					id: resource.id,
					message: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
			}
		}
		return { stoppedResourceIds, failures };
	}
}

export const DEFAULT_WORKFLOW_RUNTIME_REGISTRY = new WorkflowRuntimeRegistry();
