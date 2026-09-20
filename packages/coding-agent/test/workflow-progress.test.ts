import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkflowView } from "../src/core/workflow/view.ts";
import {
	formatWorkflowProgress,
	WorkflowProgressComponent,
} from "../src/modes/interactive/components/workflow-progress.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function workflowView(input: {
	status?: string;
	tasks?: ReadonlyArray<Record<string, unknown>>;
	agents?: ReadonlyArray<Record<string, unknown>>;
	jobs?: ReadonlyArray<Record<string, unknown>>;
	verifications?: ReadonlyArray<Record<string, unknown>>;
	blockedReason?: { message: string };
	waitingReason?: string;
	decisions?: ReadonlyArray<{ reasonCode: string; summary: string }>;
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
		decisions: input.decisions ?? [],
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
			"Workflow: Executing · Tasks 1/3",
			"Agents: 1 running · 0 queued",
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

		expect(lines).toEqual(["Workflow: Verifying · Tasks 1/1", "Verification: Passed 1 · Running 1 · Failed 1"]);
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

		expect(lines).toEqual(["Workflow: Executing · Tasks 1/2", "Current: Repair failing test", "Repair: Iteration 2"]);
	});

	it("expands Agent backend, usage, and operation hints without percentages or ETA", () => {
		const lines = formatWorkflowProgress(
			workflowView({
				tasks: [{ id: "one", kind: "agent", status: "running", title: "Inspect code" }],
				agents: [
					{
						id: "agent-1",
						taskId: "one",
						status: "running",
						profileName: "explorer",
						backend: "in-process",
						usage: { turns: 2, inputTokens: 10, outputTokens: 5 },
					},
				],
			}),
			true,
		);

		expect(lines).toContain("Agent agent-1: explorer · in-process · Running · Task one · 2 turns · 15 tokens");
		expect(lines).toContain("  Isolation: unverified · current · no artifact");
		expect(lines.at(-1)).toContain("/agent transcript");
		expect(lines.join("\n")).not.toMatch(/%|ETA/);
	});

	it("shows stable decision reasons only in the expanded panel", () => {
		const view = workflowView({
			tasks: [{ id: "one", kind: "agent", status: "ready", title: "Inspect code" }],
			decisions: [
				{
					reasonCode: "scheduler.writer_unavailable",
					summary: "The repository Writer Lease is unavailable",
				},
			],
		});

		expect(formatWorkflowProgress(view)).not.toEqual(
			expect.arrayContaining([expect.stringContaining("scheduler.writer_unavailable")]),
		);
		expect(formatWorkflowProgress(view, true)).toEqual(
			expect.arrayContaining([
				"Decision reasons:",
				"  scheduler.writer_unavailable: The repository Writer Lease is unavailable",
			]),
		);
	});

	it("shows authoritative Recovery Attempt context", () => {
		const lines = formatWorkflowProgress(
			workflowView({
				tasks: [{ id: "one", kind: "agent", status: "running", title: "Resume inspection" }],
				agents: [
					{
						id: "agent-2",
						taskId: "one",
						status: "running",
						profileName: "explorer",
						backend: "rpc",
						usage: { turns: 0, inputTokens: 0, outputTokens: 0 },
						recoveryContext: {
							sourceAttemptId: "attempt-1",
							reason: "CLI restarted",
							workspace: { status: "artifact-only" },
						},
					},
				],
			}),
			true,
		);

		expect(lines).toContain("Current: Resume inspection · Recovery Agent explorer");
		expect(lines).toContain("  Recovery: Attempt attempt-1 · artifact-only · CLI restarted");
	});

	it("keeps the terminal result visible without claiming all tasks succeeded", () => {
		expect(
			formatWorkflowProgress(
				workflowView({
					status: "failed",
					tasks: [
						{ id: "one", kind: "agent", status: "succeeded" },
						{ id: "two", kind: "agent", status: "failed" },
					],
				}),
			),
		).toEqual(["Workflow: Failed · Tasks 1/2 · Failed 1"]);
		expect(formatWorkflowProgress(workflowView({ status: "completed" }))).toEqual([
			"Workflow: Completed · Tasks pending",
		]);
	});
});

describe("WorkflowProgressComponent layout", () => {
	beforeAll(() => initTheme(undefined, false));
	it("right-aligns live task counts and adapts when repair tasks are added", () => {
		let view = workflowView({
			tasks: [
				{ id: "one", kind: "agent", status: "succeeded" },
				{ id: "two", kind: "agent", status: "running", title: "检查中文文件".repeat(20) },
			],
		});
		const component = new WorkflowProgressComponent(() => view);
		const lines = component.render(80);
		expect(stripAnsi(lines[0])).toMatch(/Tasks 1\/2$/);
		expect(visibleWidth(lines[0])).toBe(80);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		view = { ...view, tasks: [...view.tasks, { ...view.tasks[1], id: "repair", kind: "repair" }] };
		expect(stripAnsi(component.render(80)[0])).toMatch(/Tasks 1\/3$/);
	});
	it("keeps counts on a separate line in narrow terminals and clears absent workflows", () => {
		const component = new WorkflowProgressComponent(() =>
			workflowView({
				status: "awaiting_approval",
				tasks: [{ id: "one", kind: "agent", status: "ready", title: "Implement" }],
			}),
		);
		const lines = component.render(20);
		expect(lines.map(stripAnsi)).toContain("Tasks 0/1");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(component.render(0)).toEqual([]);
		expect(new WorkflowProgressComponent(() => undefined).render(80)).toEqual([]);
	});
});
