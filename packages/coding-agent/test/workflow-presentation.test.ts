import { beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { PlanWorkflowRuntime } from "../src/core/workflow/plan-runtime.ts";
import type { PlanContent } from "../src/core/workflow/types.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import {
	plannerDraftSummary,
	workflowCommandSummary,
} from "../src/modes/interactive/components/workflow-presentation.ts";
import { WorkflowProgressComponent } from "../src/modes/interactive/components/workflow-progress.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const plan: PlanContent = {
	goal: "保留显式端口 0",
	assumptions: ["仅修改 config.mjs"],
	risks: [],
	steps: [
		{
			id: "fix",
			kind: "agent",
			title: "修复端口",
			description: "用 ?? 替换 ||",
			dependsOn: [],
			fileIntents: [],
			verificationRequirementIds: [],
		},
	],
	verificationRequirements: [],
};

function runtime(): PlanWorkflowRuntime {
	const result = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		request: { text: plan.goal, cwd: process.cwd(), attachments: [] },
	});
	result.submit(plan);
	return result;
}

describe("workflow presentation", () => {
	beforeAll(() => initTheme("dark"));
	it("shows approval state from the runtime and retains raw details on expansion", () => {
		const workflow = runtime();
		const raw = workflow.statusLines.join("\n");
		const component = new CustomMessageComponent({
			role: "custom",
			customType: "workflow",
			content: raw,
			display: true,
			timestamp: 0,
			details: { command: "/plan", workflow: workflow.view() },
		});
		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("规划代理 · 计划待批准");
		expect(collapsed).toContain(plan.goal);
		expect(collapsed).not.toContain(workflow.workflow.id);
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("awaiting_approval");
	});
	it("never replaces command errors or detailed inspection with a success card", () => {
		const details = { command: "/approve", workflow: runtime().view() };
		expect(workflowCommandSummary(details, "No Plan is awaiting approval.")).toBeUndefined();
		expect(workflowCommandSummary({ ...details, command: "/tasks" }, "Usage: /tasks")).toBeUndefined();
		expect(
			workflowCommandSummary({ ...details, command: "/agent" }, "Agent missing does not exist."),
		).toBeUndefined();
	});
	it("distinguishes successful execution from overall completion and preserves failed checks", () => {
		const workflow = runtime();
		workflow.approve();
		const view = workflow.view();
		const task = view.tasks.find((entry) => entry.kind !== "control")!;
		const done = { ...view, tasks: [{ ...task, status: "succeeded" as const }] };
		const text = workflowCommandSummary({ command: "/tasks", workflow: done }, "Tasks | executing");
		expect(text).toContain("交付详情：/workflow");
		expect(text).not.toContain("工作流：已完成");
		const failed = {
			...done,
			tasks: [{ ...task, status: "failed" as const }],
			verifications: [
				{
					id: "check",
					workflowId: view.workflow.id,
					taskId: task.id,
					requirementId: "test",
					status: "failed" as const,
					summary: "端口用例失败",
					evidenceRefs: [],
				},
			],
		};
		expect(workflowCommandSummary({ command: "/tasks", workflow: failed }, "Tasks | executing")).toContain(
			"端口用例失败",
		);
		const panel = new WorkflowProgressComponent(() => done);
		const progress = stripAnsi(panel.render(80).join("\n"));
		expect(progress).toContain("执行结果已返回");
		expect(progress).not.toContain("工作流已完成");
	});
	it("formats complete plan JSON without interpreting ordinary or incomplete JSON as approval", () => {
		expect(plannerDraftSummary(JSON.stringify(plan))).toContain("计划草案");
		expect(plannerDraftSummary('{"goal":"hello"}')).toBeUndefined();
		expect(plannerDraftSummary(JSON.stringify(plan).slice(0, -1))).toBeUndefined();
		expect(plannerDraftSummary(`Example: ${JSON.stringify(plan)}`)).toBeUndefined();
	});
	it("collapses internal planning envelopes but keeps original instructions accessible", () => {
		const raw = `Execute the following workflow task using the current AgentSession.\n<workflow_prompt_envelope>\n${JSON.stringify({ role: "planner", task: { description: plan.goal }, workflowContext: [] })}\n</workflow_prompt_envelope>`;
		const component = new UserMessageComponent(raw);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("规划代理 · 分析需求");
		expect(stripAnsi(component.render(100).join("\n"))).not.toContain("workflow_prompt_envelope");
		component.setExpanded(true);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("workflow_prompt_envelope");
	});
});
