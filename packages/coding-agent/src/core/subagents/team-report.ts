import type { AgentTeamView, TeamMessage, TeamTaskProposal } from "./team-types.ts";

function target(message: TeamMessage): string {
	return message.target.agentId ?? `role:${message.target.role}`;
}

export function formatAgentTeam(view: AgentTeamView): readonly string[] {
	const executableTasks = view.board.tasks.filter(({ kind }) => kind !== "control");
	const completed = executableTasks.filter(({ status }) => status === "succeeded").length;
	const active = view.members.filter(({ agent }) =>
		["starting", "idle", "running", "waiting", "stopping"].includes(agent.status),
	).length;
	return [
		`Team | Workflow ${view.workflowId} | Tasks ${completed}/${executableTasks.length} | Members ${view.members.length} (${active} active)`,
		...view.members.map(
			({ agent, role, task }) =>
				`${agent.id} | ${role} | ${agent.status} | task ${task.id} ${task.status} | attempt ${agent.attemptId}`,
		),
		`Messages: ${view.messages.length} | Proposals: ${view.proposals.length}`,
	];
}

export function formatTeamMessages(messages: readonly TeamMessage[]): readonly string[] {
	if (messages.length === 0) {
		return ["Team messages: (none)"];
	}
	return [
		`Team messages: ${messages.length}`,
		...messages.map(
			(message) =>
				`${message.sequence}. ${message.type} | ${message.sourceAgentId} -> ${target(message)} | task ${message.taskId} | ${message.body ?? message.artifactRef ?? "(empty)"}`,
		),
	];
}

export function formatTeamProposals(proposals: readonly TeamTaskProposal[]): readonly string[] {
	if (proposals.length === 0) {
		return ["Team proposals: (none)"];
	}
	return [
		`Team proposals: ${proposals.length}`,
		...proposals.map(
			(proposal) =>
				`${proposal.id} | ${proposal.status} | ${proposal.requiredRole}/${proposal.accessMode} | ${proposal.objective}${proposal.resultingTaskId ? ` | task ${proposal.resultingTaskId}` : ""}${proposal.mergedTaskId ? ` | merged ${proposal.mergedTaskId}` : ""}${proposal.decisionReason ? ` | ${proposal.decisionReason}` : ""}`,
		),
	];
}
