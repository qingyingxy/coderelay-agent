import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
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
		return `Agent ${agent.profileName}`;
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

export function formatWorkflowProgress(view: WorkflowView | undefined): readonly string[] {
	if (!view || !ACTIVE_WORKFLOW_STATUSES.has(view.workflow.status)) {
		return [];
	}

	const tasks = view.tasks.filter(({ kind }) => kind !== "control");
	const succeeded = tasks.filter(({ status }) => status === "succeeded" || status === "skipped").length;
	const runningTasks = tasks.filter(({ status }) => status === "running" || status === "verifying");
	const waiting = tasks.filter(
		({ status }) => status === "pending" || status === "ready" || status === "blocked",
	).length;
	const failed = tasks.filter(({ status }) => status === "failed" || status === "cancelled").length;
	const statusParts = [
		`Workflow: ${label(view.workflow.status)}`,
		`Tasks ${succeeded}/${tasks.length}`,
		`Running ${runningTasks.length}`,
		`Waiting ${waiting}`,
	];
	if (failed > 0) {
		statusParts.push(`Failed ${failed}`);
	}

	const lines = [statusParts.join(" · ")];
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

	return lines.slice(0, 3);
}

export class WorkflowProgressComponent implements Component {
	private readonly getWorkflowView: () => WorkflowView | undefined;

	constructor(getWorkflowView: () => WorkflowView | undefined) {
		this.getWorkflowView = getWorkflowView;
	}

	invalidate(): void {
		// The component reads the latest Workflow View on every render.
	}

	render(width: number): string[] {
		if (width <= 0) {
			return [];
		}
		return formatWorkflowProgress(this.getWorkflowView()).map((line, index) => {
			const text = index === 0 ? theme.fg("accent", line) : theme.fg("muted", line);
			return truncateToWidth(text, width, theme.fg("muted", "..."));
		});
	}
}
