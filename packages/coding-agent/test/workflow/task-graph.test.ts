import { describe, expect, it } from "vitest";
import type { Task } from "../../src/core/workflow/index.ts";
import { createTaskGraph, validateTaskGraph, WORKFLOW_SCHEMA_VERSION } from "../../src/core/workflow/index.ts";
import { NOW, ZERO_USAGE } from "./fixtures.ts";

function task(id: string, options: { parentTaskId?: string; dependencyIds?: readonly string[] } = {}): Task {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id,
		workflowId: "workflow-graph",
		parentTaskId: options.parentTaskId,
		kind: id === "root" ? "control" : "agent",
		accessMode: "read_only",
		title: id,
		description: id,
		status: "pending",
		dependencyIds: options.dependencyIds ?? [],
		budget: {},
		usage: ZERO_USAGE,
		attemptIds: [],
		verificationRequirements: [],
		modifications: [],
	};
}

describe("Task Graph", () => {
	it("builds parent/child and dependency indexes", () => {
		const tasks = [
			task("root"),
			task("inspect", { parentTaskId: "root" }),
			task("implement", { parentTaskId: "root", dependencyIds: ["inspect"] }),
		];

		const graph = createTaskGraph("workflow-graph", tasks);

		expect(graph.rootTaskIds).toEqual(["root"]);
		expect(graph.childIdsByParent.get("root")).toEqual(["inspect", "implement"]);
		expect(graph.dependentIdsByDependency.get("inspect")).toEqual(["implement"]);
	});

	it("rejects missing references and cycles", () => {
		const violations = validateTaskGraph([
			task("a", { parentTaskId: "b", dependencyIds: ["missing"] }),
			task("b", { parentTaskId: "a", dependencyIds: ["a"] }),
			task("c", { dependencyIds: ["d"] }),
			task("d", { dependencyIds: ["c"] }),
			task("duplicate"),
			task("duplicate"),
		]);

		expect(violations.map(({ code }) => code)).toEqual(
			expect.arrayContaining([
				"task_graph.duplicate_task",
				"task_graph.dependency_missing",
				"task_graph.parent_cycle",
				"task_graph.dependency_cycle",
			]),
		);
	});
});
