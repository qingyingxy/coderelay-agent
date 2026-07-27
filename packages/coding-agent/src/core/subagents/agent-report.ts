import type { AgentId } from "../workflow/types.ts";
import type { AgentInstance, AgentRunResult, Handoff } from "./types.ts";

function usageLine(agent: AgentInstance): string {
	const usage = agent.usage;
	return `usage: ${usage.inputTokens + usage.outputTokens} tokens | ${usage.turns} turns | $${usage.cost.toFixed(4)} | ${usage.durationMs}ms`;
}

function relationshipLine(agent: AgentInstance): string {
	return [
		`task: ${agent.taskId}`,
		`parent: ${agent.parentAgentId ?? "(root)"}`,
		`depth: ${agent.depth}`,
		`session: ${agent.sessionId ?? "(starting)"}`,
	].join(" | ");
}

export function formatAgentList(agents: readonly AgentInstance[]): readonly string[] {
	if (agents.length === 0) {
		return ["Agents: (none)"];
	}
	return [
		`Agents: ${agents.length}`,
		...agents.map(
			(agent) =>
				`${agent.id} | ${agent.status} | ${agent.profileName} | task ${agent.taskId} | parent ${agent.parentAgentId ?? "(root)"} | depth ${agent.depth} | ${agent.usage.turns} turns`,
		),
	];
}

export function formatAgentDetails(
	agent: AgentInstance,
	handoff: Handoff | undefined,
	eventLines: readonly string[],
): readonly string[] {
	const lines = [
		`${agent.id} | ${agent.status} | ${agent.profileName}`,
		relationshipLine(agent),
		`attempt: ${agent.attemptId} | retry: ${agent.retryCount}${agent.retryOfAgentId ? ` of ${agent.retryOfAgentId}` : ""}`,
		usageLine(agent),
		`permissions: read=${agent.effectivePermissions.read} write=${agent.effectivePermissions.write} commands=${agent.effectivePermissions.executeCommands} network=${agent.effectivePermissions.network}`,
	];
	if (agent.lastError) {
		lines.push(`error: ${agent.lastError}`);
	}
	if (handoff) {
		lines.push(
			`handoff: ${handoff.id} | ${handoff.conclusion}`,
			`changed: ${handoff.changedFiles.join(", ") || "(none)"}`,
			`risks: ${handoff.risks.join("; ") || "(none)"}`,
			`unfinished: ${handoff.unfinishedItems.join("; ") || "(none)"}`,
		);
	}
	if (eventLines.length > 0) {
		lines.push("events:", ...eventLines);
	}
	return lines;
}

export function formatAgentRunResult(result: AgentRunResult): readonly string[] {
	return [
		`${result.agentId} | ${result.status}`,
		`usage: ${result.usage.inputTokens + result.usage.outputTokens} tokens | ${result.usage.turns} turns | $${result.usage.cost.toFixed(4)} | ${result.usage.durationMs}ms`,
		`changed: ${result.modifications.map(({ path }) => path).join(", ") || "(none)"}`,
		...(result.handoff ? [`handoff: ${result.handoff.id} | ${result.handoff.conclusion}`] : []),
		...(result.error ? [`error: ${result.error}`] : []),
	];
}

export function formatAgentEvents(
	events: readonly { sequence: number; agentId: AgentId; type: string; message?: string }[],
): readonly string[] {
	return events
		.slice(-8)
		.map(({ sequence, type, message }) => `  ${sequence}. ${type}${message ? ` | ${message}` : ""}`);
}
