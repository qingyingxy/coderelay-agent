import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { formatWorkflowCost } from "../../../core/workflow/cost.ts";
import type { WorkflowView } from "../../../core/workflow/view.ts";
import { theme } from "../theme/theme.ts";

const ACTIVE_WORKFLOW_STATUSES = new Set([
	"received",
	"clarifying",
	"planning",
	"awaiting_approval",
	"executing",
	"verifying",
	"blocked",
	"cancelling",
]);

function sanitize(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function label(value: string): string {
	return value
		.split("_")
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function taskExecutor(view: WorkflowView, taskId: string): string | undefined {
	const agent = view.agents.find(
		(candidate) =>
			candidate.taskId === taskId &&
			["starting", "idle", "running", "waiting", "stopping"].includes(candidate.status),
	);
	if (agent) {
		return agent.recoveryContext ? `Recovery Agent ${agent.profileName}` : `Agent ${agent.profileName}`;
	}

	const job = view.jobs.find(
		(candidate) => candidate.taskId === taskId && ["queued", "running"].includes(candidate.status),
	);
	if (job) {
		return "Job";
	}

	const task = view.tasks.find((candidate) => candidate.id === taskId);
	if (task?.assignment?.executorKind === "main_agent") {
		return "Main agent";
	}
	if (task?.assignment?.executorKind === "subagent") {
		return "Subagent";
	}
	if (task?.assignment?.executorKind === "job") {
		return "Job";
	}
	return undefined;
}

export function formatWorkflowProgress(view: WorkflowView | undefined, expanded = false): readonly string[] {
	if (!view || !ACTIVE_WORKFLOW_STATUSES.has(view.workflow.status)) {
		return [];
	}

	const tasks = view.tasks.filter(({ kind }) => kind !== "control");
	const succeeded = tasks.filter(({ status }) => status === "succeeded" || status === "skipped").length;
	const runningTasks = tasks.filter(({ status }) => status === "running" || status === "verifying");
	const failed = tasks.filter(({ status }) => status === "failed" || status === "cancelled").length;
	const statusParts = [`Workflow: ${label(view.workflow.status)}`, `Tasks ${succeeded}/${tasks.length}`];
	if (view.cost) {
		statusParts.push(`~$${view.cost.totalEstimatedUsd.toFixed(6)}${view.cost.hostAttributed ? "" : " (partial)"}`);
	}
	if (failed > 0) {
		statusParts.push(`Failed ${failed}`);
	}

	const lines = [statusParts.join(" · ")];
	const runningAgents = view.agents.filter(({ status }) => status === "running" || status === "waiting");
	const queuedAgents = view.agents.filter(
		({ handoffId, status }) => !handoffId && (status === "starting" || status === "idle"),
	);
	lines.push(`Agents: ${runningAgents.length} running · ${queuedAgents.length} queued`);
	const currentTask =
		runningTasks[0] ??
		tasks.find(({ kind, status }) => kind === "repair" && status === "ready") ??
		tasks.find(({ status }) => status === "ready") ??
		tasks.find(({ status }) => status === "blocked");
	if (currentTask) {
		const executor = taskExecutor(view, currentTask.id);
		lines.push(`Current: ${sanitize(currentTask.title)}${executor ? ` · ${executor}` : ""}`);
	} else if (view.workflow.status === "planning") {
		lines.push("Current: Creating the Plan");
	} else if (view.workflow.status === "awaiting_approval") {
		lines.push("Current: Waiting for Plan approval");
	} else if (view.workflow.status === "clarifying") {
		lines.push("Current: Waiting for clarification");
	}

	const verificationCounts = {
		passed: view.verifications.filter(({ status }) => status === "passed").length,
		running: view.verifications.filter(({ status }) => status === "running").length,
		failed: view.verifications.filter(({ status }) => status === "failed").length,
	};
	const repairTasks = tasks.filter(({ kind }) => kind === "repair");
	if (view.workflow.status === "verifying" || verificationCounts.running > 0) {
		lines.push(
			`Verification: Passed ${verificationCounts.passed} · Running ${verificationCounts.running} · Failed ${verificationCounts.failed}`,
		);
	} else if (currentTask?.kind === "repair" || repairTasks.some(({ status }) => status === "running")) {
		const iteration = Math.max(1, ...repairTasks.map(({ repairIteration }) => repairIteration ?? 1));
		lines.push(`Repair: Iteration ${iteration}`);
	} else if (view.workflow.status === "awaiting_approval") {
		lines.push("Action: /approve · /replan · /reject");
	} else if (view.workflow.status === "blocked") {
		lines.push(`Blocked: ${sanitize(view.workflow.blockedReason?.message ?? "Waiting for a dependency or input")}`);
	} else if (view.workflow.status === "cancelling") {
		lines.push("Current: Stopping active Agents and Jobs");
	} else if (tasks.length > 0 && succeeded === tasks.length) {
		lines.push("Next: Verification");
	} else if (view.automation?.waitingReason && view.automation.waitingReason !== "active_resources") {
		lines.push(`Waiting: ${label(view.automation.waitingReason)}`);
	}

	if (expanded) {
		if (view.cost) lines.push(formatWorkflowCost(view.cost));
		const activeAgents = view.agents.filter(
			({ handoffId, status }) =>
				!handoffId && ["starting", "idle", "running", "waiting", "stopping", "failed"].includes(status),
		);
		lines.push(
			...activeAgents.map(
				(agent) =>
					`Agent ${agent.id}: ${agent.profileName} · ${agent.backend} · ${label(agent.status)} · Task ${agent.taskId} · ${agent.usage.turns} turns · ${agent.usage.inputTokens + agent.usage.outputTokens} tokens`,
			),
		);
		lines.push(
			...activeAgents.map(
				(agent) =>
					`  Isolation: ${agent.sandbox?.assurance ?? "unverified"} · ${agent.workspace?.kind ?? "current"} · ${agent.artifact?.status ?? "no artifact"}${agent.sandbox?.missingGuarantees.length ? ` · ${agent.sandbox.missingGuarantees.length} limitation(s)` : ""}`,
			),
		);
		lines.push(
			...activeAgents.flatMap((agent) =>
				agent.recoveryContext
					? [
							`  Recovery: Attempt ${agent.recoveryContext.sourceAttemptId} · ${agent.recoveryContext.workspace.status} · ${sanitize(agent.recoveryContext.reason)}`,
						]
					: [],
			),
		);
		const decisions = (view.decisions ?? []).slice(-6);
		if (decisions.length > 0) {
			lines.push(
				"Decision reasons:",
				...decisions.map(({ reasonCode, summary }) => `  ${reasonCode}: ${sanitize(summary)}`),
			);
		}
		if (activeAgents.length > 0) {
			lines.push("Agent actions: /agent show · /agent transcript · /agent send · /agent interrupt · /agent resume");
		}
		return lines;
	}
	return lines.slice(0, 3);
}

export class WorkflowProgressComponent implements Component {
	private readonly getWorkflowView: () => WorkflowView | undefined;
	private expanded = false;

	constructor(getWorkflowView: () => WorkflowView | undefined) {
		this.getWorkflowView = getWorkflowView;
	}

	invalidate(): void {
		// The component reads the latest Workflow View on every render.
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	toggleExpanded(): void {
		this.expanded = !this.expanded;
	}

	render(width: number): string[] {
		if (width <= 0) {
			return [];
		}
		return formatWorkflowProgress(this.getWorkflowView(), this.expanded).map((line, index) => {
			const text = index === 0 ? theme.fg("accent", line) : theme.fg("muted", line);
			return truncateToWidth(text, width, theme.fg("muted", "..."));
		});
	}
}
