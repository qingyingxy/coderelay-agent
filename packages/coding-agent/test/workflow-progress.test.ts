import { describe, expect, it } from "vitest";
import type { WorkflowView } from "../src/core/workflow/view.ts";
import { formatWorkflowProgress } from "../src/modes/interactive/components/workflow-progress.ts";

function workflowView(input: {
	status?: string;
	tasks?: ReadonlyArray<Record<string, unknown>>;
	agents?: ReadonlyArray<Record<string, unknown>>;
	jobs?: ReadonlyArray<Record<string, unknown>>;
	verifications?: ReadonlyArray<Record<string, unknown>>;
	blockedReason?: { message: string };
	waitingReason?: string;
}): WorkflowView {
	return {
		workflow: {
			status: input.status ?? "executing",
			blockedReason: input.blockedReason,
		},
		tasks: input.tasks ?? [],
		agents: input.agents ?? [],
		jobs: input.jobs ?? [],
		verifications: input.verifications ?? [],
		automation: input.waitingReason ? { waitingReason: input.waitingReason } : undefined,
	} as unknown as WorkflowView;
}

describe("formatWorkflowProgress", () => {
	it("shows task counts, current task, and executor", () => {
		const lines = formatWorkflowProgress(
			workflowView({
				tasks: [
					{ id: "one", kind: "agent", status: "succeeded", title: "Inspect code" },
					{ id: "two", kind: "agent", status: "running", title: "Fix Windows tests" },
					{ id: "three", kind: "command", status: "ready", title: "Run tests" },
					{ id: "control", kind: "control", status: "running", title: "Delivery control" },
				],
				agents: [{ taskId: "two", status: "running", profileName: "worker-2" }],
			}),
		);

		expect(lines).toEqual([
			"Workflow: Executing · Tasks 1/3 · Running 1 · Waiting 1",
			"Current: Fix Windows tests · Agent worker-2",
		]);
	});

	it("shows verification counts", () => {
		const lines = formatWorkflowProgress(
			workflowView({
				status: "verifying",
				tasks: [{ id: "one", kind: "agent", status: "succeeded", title: "Implement feature" }],
				verifications: [{ status: "passed" }, { status: "running" }, { status: "failed" }],
			}),
		);

		expect(lines).toEqual([
			"Workflow: Verifying · Tasks 1/1 · Running 0 · Waiting 0",
			"Verification: Passed 1 · Running 1 · Failed 1",
		]);
	});

	it("shows the active repair iteration", () => {
		const lines = formatWorkflowProgress(
			workflowView({
				tasks: [
					{ id: "one", kind: "agent", status: "succeeded", title: "Implement feature" },
					{
						id: "repair",
						kind: "repair",
						status: "running",
						title: "Repair failing test",
						repairIteration: 2,
					},
				],
			}),
		);

		expect(lines).toEqual([
			"Workflow: Executing · Tasks 1/2 · Running 1 · Waiting 0",
			"Current: Repair failing test",
			"Repair: Iteration 2",
		]);
	});

	it("hides terminal workflows", () => {
		expect(formatWorkflowProgress(workflowView({ status: "completed" }))).toEqual([]);
	});
});
