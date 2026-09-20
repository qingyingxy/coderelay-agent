import type { AgentInstance } from "../../../core/subagents/types.ts";
import { parsePlannerPlanContent } from "../../../core/workflow/planner-runtime.ts";
import type { PlanContent, Task } from "../../../core/workflow/types.ts";
import type { WorkflowView } from "../../../core/workflow/view.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agentRoleLabel(agent: AgentInstance): string {
	const role = agent.profile?.role ?? agent.profileName;
	const roles: Record<string, string> = {
		planner: "规划代理",
		planner_lite: "规划代理",
		worker: "执行代理",
		explorer: "探索代理",
		reviewer: "审查代理",
		mode_advisor: "任务分析代理",
	};
	return roles[role] ?? `代理 ${agent.profileName}`;
}

export function planSummary(plan: PlanContent): string[] {
	return [
		`目标：${plan.goal}`,
		...plan.steps.map((step, index) => `${index + 1}. ${step.description}`),
		...plan.assumptions.map((assumption) => `边界：${assumption}`),
		...plan.verificationRequirements.map(
			(requirement) =>
				`验收${requirement.required ? "" : "（可选）"}：${requirement.description.startsWith("Structured Handoff validates Agent Task: ") ? "执行代理提供完整交接结果" : requirement.description}`,
		),
		...plan.risks.map((risk) => `风险：${risk.description}；应对：${risk.mitigation}`),
	];
}

/** Format only a complete Plan-shaped JSON document; ordinary text stays untouched. */
export function plannerDraftSummary(text: string): string | undefined {
	if (!text.trim().startsWith("{") || !text.trim().endsWith("}")) return undefined;
	try {
		const plan = parsePlannerPlanContent(text);
		return ["计划草案（模型输出，审批状态见工作流）", ...planSummary(plan)].join("\n");
	} catch {
		return undefined;
	}
}

export function workflowPromptSummary(text: string): string | undefined {
	if (!text.startsWith("Execute the following workflow task using the current AgentSession.\n")) return undefined;
	const match = text.match(/<workflow_prompt_envelope>\n([\s\S]+)\n<\/workflow_prompt_envelope>$/);
	if (!match) return undefined;
	try {
		const payload: unknown = JSON.parse(match[1]);
		if (!isRecord(payload) || !isRecord(payload.task) || !Array.isArray(payload.workflowContext)) return undefined;
		if (payload.role !== "planner" && payload.role !== "planner_lite") return undefined;
		const request = payload.workflowContext.find(
			(entry: unknown) => isRecord(entry) && entry.source === "user_request",
		);
		const goal =
			isRecord(request) && typeof request.content === "string" ? request.content : payload.task.description;
		return typeof goal === "string" ? `规划代理 · 分析需求\n${goal}` : undefined;
	} catch {
		return undefined;
	}
}

function taskSummary(task: Task, view: WorkflowView): string[] {
	const agent = view.agents.find((candidate) => candidate.id === task.assignment?.agentId);
	const role = agent ? agentRoleLabel(agent) : task.kind === "command" ? "命令任务" : "执行任务";
	const states: Record<string, string> = {
		pending: "等待依赖",
		ready: "等待执行",
		running: "正在执行",
		verifying: "正在验收",
		succeeded: "已完成",
		failed: "失败",
		cancelled: "已取消",
		blocked: "受阻",
		skipped: "已跳过",
	};
	const status = task.status === "succeeded" && agent && task.result ? "已交付" : (states[task.status] ?? task.status);
	const lines = [`${role} · ${status}`, `任务：${task.title}`];
	if (agent?.modelRoute) lines.push(`模型：${agent.modelRoute.modelName}`);
	const step = view.plan?.steps.find((entry) => entry.id === task.sourcePlanStepId);
	if (!task.result && step) {
		if (step.fileIntents.length) lines.push(`接收范围：${step.fileIntents.map((intent) => intent.path).join("、")}`);
		lines.push(`实现要求：${step.description}`);
	}
	if (task.result) {
		lines.push(`结果：${task.result.summary}`);
		if (task.result.changedFiles.length) lines.push(`修改：${task.result.changedFiles.join("、")}`);
	}
	const checks = view.verifications.filter(
		(check) => check.taskId === task.id || task.result?.verificationIds.includes(check.id),
	);
	if (checks.length) {
		lines.push(`验收：${checks.filter((check) => check.status === "passed").length}/${checks.length} 项检查通过`);
		for (const check of checks.filter((entry) => entry.status !== "passed")) {
			lines.push(`检查 ${check.status}：${check.summary}`);
		}
	}
	if (task.blockedReason) lines.push(`受阻：${task.blockedReason.message}`);
	if (agent?.lastError) lines.push(`错误：${agent.lastError}`);
	return lines;
}

/** Compact only known status outputs. Usage errors and detailed commands retain their original output. */
export function workflowCommandSummary(details: unknown, raw: string): string | undefined {
	if (!isRecord(details) || !isRecord(details.workflow)) return undefined;
	const candidate = details.workflow;
	if (
		!isRecord(candidate.workflow) ||
		!Array.isArray(candidate.tasks) ||
		!Array.isArray(candidate.agents) ||
		!Array.isArray(candidate.verifications)
	)
		return undefined;
	const view = candidate as unknown as WorkflowView;
	try {
		if ((details.command === "/plan" || details.command === "/approve") && raw.startsWith("plan |") && view.plan) {
			const states: Record<string, string> = {
				awaiting_approval: "计划待批准",
				approved: "计划已批准",
				rejected: "计划已拒绝",
				superseded: "计划已更新",
			};
			return [
				`规划代理 · ${states[view.plan.status] ?? view.plan.status}`,
				...planSummary(view.plan),
				...(view.workflow.status === "awaiting_approval"
					? ["下一步：/approve 批准 · /replan 调整 · /reject 拒绝"]
					: []),
			].join("\n");
		}
		let tasks: readonly Task[];
		if (details.command === "/agents" && /^(Dispatched \d+ Subagents?\.|Agents:)/.test(raw)) {
			const ids = new Set(view.agents.map((agent) => agent.taskId));
			tasks = view.tasks.filter((task) => ids.has(task.id));
		} else if (details.command === "/tasks" && raw.startsWith("Tasks |")) {
			tasks = view.tasks.filter((task) => task.kind !== "control");
		} else if (details.command === "/agent") {
			const match = raw.match(/^(\S+) \| (completed|failed|interrupted)\nusage:/);
			const agent = match && view.agents.find((entry) => entry.id === match[1]);
			if (!agent) return undefined;
			tasks = view.tasks.filter((task) => task.id === agent.taskId);
		} else return undefined;
		if (!tasks.length) return undefined;
		const lines = tasks.flatMap((task) => taskSummary(task, view));
		lines.push(...raw.split("\n").filter((line) => line.startsWith("error:")));
		if (view.workflow.status === "completed") lines.push("工作流：已完成");
		else if (tasks.every((task) => task.status === "succeeded")) lines.push("交付详情：/workflow");
		return lines.join("\n");
	} catch {
		// Extension messages and older persisted shapes must remain readable.
		return undefined;
	}
}
