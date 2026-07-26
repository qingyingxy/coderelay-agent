import { describe, expect, it } from "vitest";
import { WorkflowRuntimeRegistry } from "../../src/core/workflow/index.ts";

describe("Workflow Runtime Registry", () => {
	it("stops all Workflow resources and reports cleanup failures", async () => {
		const registry = new WorkflowRuntimeRegistry();
		const stopped: string[] = [];
		registry.register({
			id: "agent-1",
			kind: "agent",
			workflowId: "workflow-1",
			taskId: "task-1",
			stop: async (reason) => {
				stopped.push(`agent:${reason}`);
			},
		});
		registry.register({
			id: "job-1",
			kind: "job",
			workflowId: "workflow-1",
			taskId: "task-2",
			stop: async () => {
				throw new Error("kill failed");
			},
		});

		const result = await registry.cancelWorkflow("workflow-1", "cancelled");

		expect(stopped).toEqual(["agent:cancelled"]);
		expect(result.stoppedResourceIds).toEqual(["agent-1"]);
		expect(result.failures).toEqual([{ id: "job-1", message: "kill failed" }]);
		expect(registry.list("workflow-1").map(({ id }) => id)).toEqual(["job-1"]);
	});
});
