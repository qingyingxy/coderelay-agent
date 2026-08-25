import { randomUUID } from "crypto";
import type { AgentId, IsoDateTime, Task, TaskId, Workflow, WorkflowId } from "../workflow/types.ts";
import type { AgentTeamPersistence } from "./team-persistence.ts";
import type {
	AgentTeamView,
	TeamAuditEvent,
	TeamMemberView,
	TeamMessage,
	TeamMessageDraft,
	TeamProposalDecision,
	TeamRole,
	TeamTaskProposal,
	TeamTaskProposalDraft,
} from "./team-types.ts";
import type { AgentInstance } from "./types.ts";

export interface AgentTeamAuthority {
	getWorkflow(workflowId: WorkflowId): Workflow | undefined;
	getTask(taskId: TaskId): Task | undefined;
	listTasks(workflowId: WorkflowId): readonly Task[];
	createTask(proposal: TeamTaskProposal, admission: { readonly highRiskApproved: boolean }): Task;
}

export interface AgentTeamDirectory {
	get(agentId: AgentId): AgentInstance | undefined;
	list(workflowId?: WorkflowId): readonly AgentInstance[];
}

export interface AgentTeamPolicy {
	readonly maxMessageBodyChars: number;
	readonly maxArtifactRefChars: number;
	readonly maxMessagesPerAgentPerWindow: number;
	readonly maxProposalsPerAgentPerWindow: number;
	readonly rateWindowMs: number;
	readonly maxVisibleMessagesPerWorkflow: number;
}

export const DEFAULT_AGENT_TEAM_POLICY: AgentTeamPolicy = {
	maxMessageBodyChars: 4_000,
	maxArtifactRefChars: 1_024,
	maxMessagesPerAgentPerWindow: 24,
	maxProposalsPerAgentPerWindow: 8,
	rateWindowMs: 60_000,
	maxVisibleMessagesPerWorkflow: 256,
};

export interface GovernedAgentTeamOptions {
	readonly authority: AgentTeamAuthority;
	readonly agents: AgentTeamDirectory;
	readonly persistence?: AgentTeamPersistence;
	readonly policy?: Partial<AgentTeamPolicy>;
	readonly createId?: () => string;
	readonly now?: () => IsoDateTime;
}

export class GovernedAgentTeamError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "GovernedAgentTeamError";
		this.code = code;
	}
}

function fail(code: string, message: string): never {
	throw new GovernedAgentTeamError(code, message);
}

function normalizedRequired(value: string, code: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) {
		fail(code, `${label} is required`);
	}
	return normalized;
}

function agentIsTerminal(agent: AgentInstance): boolean {
	return (
		agent.handoffId !== undefined ||
		agent.sessionReleasedAt !== undefined ||
		agent.status === "stopped" ||
		agent.status === "failed" ||
		agent.status === "interrupted"
	);
}

function teamRole(agent: AgentInstance, task: Task): TeamRole {
	if (task.kind === "repair") {
		return "repair";
	}
	switch (agent.profile?.role) {
		case "planner":
		case "planner_lite":
		case "mode_advisor":
			return "coordinator";
		case "reviewer":
			return "reviewer";
		case "worker":
			return "worker";
		case "explorer":
			return "explorer";
		case undefined:
			if (agent.profileName.includes("review")) {
				return "reviewer";
			}
			if (agent.profileName.includes("worker")) {
				return "worker";
			}
			return "explorer";
	}
}

function targetKey(target: TeamMessageDraft["target"]): string {
	return target.agentId ? `agent:${target.agentId}` : `role:${target.role}`;
}

function messageFingerprint(message: TeamMessageDraft): string {
	return [
		message.workflowId,
		message.sourceAgentId,
		targetKey(message.target),
		message.taskId,
		message.attemptId,
		message.type,
		message.body?.trim() ?? "",
		message.artifactRef?.trim() ?? "",
	].join("\u0000");
}

function proposalFingerprint(proposal: TeamTaskProposalDraft): string {
	return [
		proposal.workflowId,
		proposal.objective.trim().toLowerCase(),
		[...new Set(proposal.suggestedDependencyIds)].sort().join(","),
		proposal.requiredRole,
		proposal.accessMode,
		proposal.verification.kind,
		proposal.verification.description.trim().toLowerCase(),
		proposal.verification.command?.trim() ?? "",
	].join("\u0000");
}

export class GovernedAgentTeam {
	readonly #authority: AgentTeamAuthority;
	readonly #agents: AgentTeamDirectory;
	readonly #persistence: AgentTeamPersistence | undefined;
	readonly #policy: AgentTeamPolicy;
	readonly #createId: () => string;
	readonly #now: () => IsoDateTime;
	readonly #messages = new Map<string, TeamMessage>();
	readonly #proposals = new Map<string, TeamTaskProposal>();
	readonly #events: TeamAuditEvent[] = [];
	#sequence = 0;

	constructor(options: GovernedAgentTeamOptions) {
		this.#authority = options.authority;
		this.#agents = options.agents;
		this.#persistence = options.persistence;
		this.#policy = { ...DEFAULT_AGENT_TEAM_POLICY, ...options.policy };
		this.#createId = options.createId ?? randomUUID;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#validatePolicy();
		for (const event of options.persistence?.load() ?? []) {
			this.#restore(event);
		}
	}

	sendMessage(draft: TeamMessageDraft): TeamMessage {
		const source = this.#requireActiveSource(draft.workflowId, draft.sourceAgentId, draft.taskId, draft.attemptId);
		const hasAgentTarget = draft.target.agentId !== undefined;
		const hasRoleTarget = draft.target.role !== undefined;
		if (hasAgentTarget === hasRoleTarget) {
			fail("agent_team.invalid_target", "Team message requires exactly one target Agent or role");
		}
		const body = draft.body?.trim();
		const artifactRef = draft.artifactRef?.trim();
		if (!body && !artifactRef) {
			fail("agent_team.empty_message", "Team message requires a body or Artifact reference");
		}
		if ((body?.length ?? 0) > this.#policy.maxMessageBodyChars) {
			fail(
				"agent_team.message_too_large",
				`Team message body exceeds ${this.#policy.maxMessageBodyChars} characters`,
			);
		}
		if ((artifactRef?.length ?? 0) > this.#policy.maxArtifactRefChars) {
			fail(
				"agent_team.artifact_ref_too_large",
				`Artifact reference exceeds ${this.#policy.maxArtifactRefChars} characters`,
			);
		}
		const targetAgent = draft.target.agentId ? this.#agents.get(draft.target.agentId) : undefined;
		if (
			draft.target.agentId &&
			(!targetAgent || targetAgent.workflowId !== draft.workflowId || agentIsTerminal(targetAgent))
		) {
			fail(
				"agent_team.target_unavailable",
				`Target Agent ${draft.target.agentId} is not active in Workflow ${draft.workflowId}`,
			);
		}
		this.#assertRate(
			draft.workflowId,
			draft.sourceAgentId,
			"message.sent",
			this.#policy.maxMessagesPerAgentPerWindow,
		);
		const normalizedDraft: TeamMessageDraft = {
			...structuredClone(draft),
			target: structuredClone(draft.target),
			body,
			artifactRef,
		};
		const fingerprint = messageFingerprint(normalizedDraft);
		if (
			[...this.#messages.values()].some(
				(message) => messageFingerprint(message) === fingerprint && this.#withinWindow(message.occurredAt),
			)
		) {
			fail("agent_team.duplicate_message", "Duplicate Team message was suppressed");
		}
		if (
			draft.type === "handoff_request" &&
			targetAgent &&
			(targetAgent.id === source.id || this.#hasHandoffPath(targetAgent.id, source.id, draft.workflowId))
		) {
			fail("agent_team.delegation_cycle", "Handoff request would create a delegation cycle");
		}
		const occurredAt = this.#now();
		const message: TeamMessage = {
			...normalizedDraft,
			id: this.#createId(),
			sequence: this.#sequence + 1,
			occurredAt,
		};
		this.#append({
			sequence: message.sequence,
			workflowId: message.workflowId,
			type: "message.sent",
			occurredAt,
			message,
		});
		return structuredClone(message);
	}

	submitProposal(draft: TeamTaskProposalDraft): TeamTaskProposal {
		this.#requireActiveSource(draft.workflowId, draft.sourceAgentId, draft.sourceTaskId, draft.sourceAttemptId);
		this.#assertRate(
			draft.workflowId,
			draft.sourceAgentId,
			"proposal.submitted",
			this.#policy.maxProposalsPerAgentPerWindow,
		);
		const workflow = this.#authority.getWorkflow(draft.workflowId);
		if (!workflow || workflow.status !== "executing") {
			fail("agent_team.workflow_not_executing", `Workflow ${draft.workflowId} is not executing`);
		}
		const objective = normalizedRequired(
			draft.objective,
			"agent_team.proposal_objective_required",
			"Proposal objective",
		);
		const reason = normalizedRequired(draft.reason, "agent_team.proposal_reason_required", "Proposal reason");
		const risk = normalizedRequired(draft.risk, "agent_team.proposal_risk_required", "Proposal risk");
		const verificationDescription = normalizedRequired(
			draft.verification.description,
			"agent_team.proposal_verification_required",
			"Proposal verification",
		);
		const dependencyIds = [...new Set(draft.suggestedDependencyIds)];
		for (const dependencyId of dependencyIds) {
			const dependency = this.#authority.getTask(dependencyId);
			if (!dependency || dependency.workflowId !== draft.workflowId) {
				fail(
					"agent_team.dependency_outside_workflow",
					`Dependency Task ${dependencyId} is not in Workflow ${draft.workflowId}`,
				);
			}
		}
		if (draft.requiredRole === "repair") {
			fail("agent_team.repair_proposal_denied", "Repair Tasks require a failed Verification");
		}
		if (draft.accessMode === "writer" && draft.requiredRole !== "worker") {
			fail("agent_team.writer_role_required", "Writer proposal requires the worker role");
		}
		if (draft.accessMode === "read_only" && draft.requiredRole === "worker") {
			fail(
				"agent_team.read_only_role_required",
				"Read-only proposal requires coordinator, explorer, or reviewer role",
			);
		}
		const normalizedDraft: TeamTaskProposalDraft = {
			...structuredClone(draft),
			objective,
			reason,
			risk,
			suggestedDependencyIds: dependencyIds,
			verification: {
				...structuredClone(draft.verification),
				description: verificationDescription,
				command: draft.verification.command?.trim() || undefined,
			},
		};
		const fingerprint = proposalFingerprint(normalizedDraft);
		if (
			[...this.#proposals.values()].some(
				(proposal) => proposal.status !== "rejected" && proposalFingerprint(proposal) === fingerprint,
			)
		) {
			fail("agent_team.duplicate_proposal", "Duplicate Task Proposal was suppressed");
		}
		const occurredAt = this.#now();
		const proposal: TeamTaskProposal = {
			...normalizedDraft,
			id: this.#createId(),
			status: "pending",
			createdAt: occurredAt,
			updatedAt: occurredAt,
			revision: 0,
		};
		this.#append({
			sequence: this.#sequence + 1,
			workflowId: proposal.workflowId,
			type: "proposal.submitted",
			occurredAt,
			proposal,
		});
		return structuredClone(proposal);
	}

	decideProposal(proposalId: string, decision: TeamProposalDecision): TeamTaskProposal {
		const current = this.#proposals.get(proposalId);
		if (!current) {
			fail("agent_team.proposal_missing", `Task Proposal ${proposalId} does not exist`);
		}
		if (current.status !== "pending" && current.status !== "approval_required") {
			fail("agent_team.proposal_terminal", `Task Proposal ${proposalId} is already ${current.status}`);
		}
		const reason = normalizedRequired(
			decision.reason,
			"agent_team.proposal_decision_reason_required",
			"Proposal decision reason",
		);
		const occurredAt = this.#now();
		if (decision.action === "accept" && current.riskLevel === "high" && !decision.userApprovedHighRisk) {
			return this.#resolve(current, {
				status: "approval_required",
				decisionActor: decision.actor,
				decisionReason: "High-risk Team proposal requires explicit user approval",
				updatedAt: occurredAt,
				revision: current.revision + 1,
			});
		}
		switch (decision.action) {
			case "accept": {
				const task = this.#authority.createTask(current, {
					highRiskApproved: decision.userApprovedHighRisk ?? false,
				});
				if (task.workflowId !== current.workflowId || task.sourceProposalId !== current.id) {
					fail("agent_team.authority_contract", "Controller returned a Task with invalid proposal ownership");
				}
				return this.#resolve(current, {
					status: "accepted",
					decisionActor: decision.actor,
					decisionReason: reason,
					resultingTaskId: task.id,
					updatedAt: occurredAt,
					revision: current.revision + 1,
				});
			}
			case "merge": {
				const task = this.#authority.getTask(decision.taskId);
				if (!task || task.workflowId !== current.workflowId) {
					fail(
						"agent_team.merge_task_missing",
						`Merge target Task ${decision.taskId} is not in Workflow ${current.workflowId}`,
					);
				}
				return this.#resolve(current, {
					status: "merged",
					decisionActor: decision.actor,
					decisionReason: reason,
					mergedTaskId: task.id,
					updatedAt: occurredAt,
					revision: current.revision + 1,
				});
			}
			case "reject":
				return this.#resolve(current, {
					status: "rejected",
					decisionActor: decision.actor,
					decisionReason: reason,
					updatedAt: occurredAt,
					revision: current.revision + 1,
				});
			case "require_approval":
				return this.#resolve(current, {
					status: "approval_required",
					decisionActor: decision.actor,
					decisionReason: reason,
					updatedAt: occurredAt,
					revision: current.revision + 1,
				});
		}
	}

	getMessage(messageId: string): TeamMessage | undefined {
		const message = this.#messages.get(messageId);
		return message ? structuredClone(message) : undefined;
	}

	messages(workflowId: WorkflowId): readonly TeamMessage[] {
		return [...this.#messages.values()]
			.filter((message) => message.workflowId === workflowId)
			.sort((left, right) => left.sequence - right.sequence)
			.slice(-this.#policy.maxVisibleMessagesPerWorkflow)
			.map((message) => structuredClone(message));
	}

	getProposal(proposalId: string): TeamTaskProposal | undefined {
		const proposal = this.#proposals.get(proposalId);
		return proposal ? structuredClone(proposal) : undefined;
	}

	proposals(workflowId: WorkflowId): readonly TeamTaskProposal[] {
		return [...this.#proposals.values()]
			.filter((proposal) => proposal.workflowId === workflowId)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.map((proposal) => structuredClone(proposal));
	}

	events(workflowId?: WorkflowId): readonly TeamAuditEvent[] {
		return this.#events
			.filter((event) => workflowId === undefined || event.workflowId === workflowId)
			.map((event) => structuredClone(event));
	}

	view(workflowId: WorkflowId): AgentTeamView {
		const workflow = this.#authority.getWorkflow(workflowId);
		if (!workflow) {
			fail("agent_team.workflow_missing", `Workflow ${workflowId} does not exist`);
		}
		const tasks = this.#authority.listTasks(workflowId);
		const tasksById = new Map(tasks.map((task) => [task.id, task]));
		const members: TeamMemberView[] = [];
		for (const agent of this.#agents.list(workflowId)) {
			const task = tasksById.get(agent.taskId);
			if (!task) {
				continue;
			}
			members.push({
				agent: structuredClone(agent),
				role: teamRole(agent, task),
				task: structuredClone(task),
				artifact: agent.artifact ? structuredClone(agent.artifact) : undefined,
			});
		}
		return {
			workflowId,
			board: {
				workflow: structuredClone(workflow),
				tasks: tasks.map((task) => structuredClone(task)),
			},
			members,
			messages: this.messages(workflowId),
			proposals: this.proposals(workflowId),
			events: this.events(workflowId),
		};
	}

	#resolve(
		current: TeamTaskProposal,
		change: Pick<TeamTaskProposal, "status" | "decisionActor" | "decisionReason" | "updatedAt" | "revision"> & {
			readonly resultingTaskId?: TaskId;
			readonly mergedTaskId?: TaskId;
		},
	): TeamTaskProposal {
		const proposal: TeamTaskProposal = { ...current, ...change };
		const type =
			proposal.status === "approval_required"
				? "proposal.approval_required"
				: proposal.status === "accepted"
					? "proposal.accepted"
					: proposal.status === "merged"
						? "proposal.merged"
						: "proposal.rejected";
		this.#append({
			sequence: this.#sequence + 1,
			workflowId: proposal.workflowId,
			type,
			occurredAt: proposal.updatedAt,
			proposal,
		});
		return structuredClone(proposal);
	}

	#requireActiveSource(workflowId: WorkflowId, agentId: AgentId, taskId: TaskId, attemptId: string): AgentInstance {
		const agent = this.#agents.get(agentId);
		if (!agent || agent.workflowId !== workflowId || agent.taskId !== taskId || agent.attemptId !== attemptId) {
			fail("agent_team.source_binding", `Agent ${agentId} is not bound to the supplied Workflow Task Attempt`);
		}
		if (agentIsTerminal(agent)) {
			fail("agent_team.source_terminal", `Agent ${agentId} cannot communicate after reaching terminal state`);
		}
		return agent;
	}

	#assertRate(
		workflowId: WorkflowId,
		sourceAgentId: AgentId,
		eventType: "message.sent" | "proposal.submitted",
		limit: number,
	): void {
		const count = this.#events.filter((event) => {
			if (event.workflowId !== workflowId || event.type !== eventType || !this.#withinWindow(event.occurredAt)) {
				return false;
			}
			return event.type === "message.sent"
				? event.message.sourceAgentId === sourceAgentId
				: event.proposal.sourceAgentId === sourceAgentId;
		}).length;
		if (count >= limit) {
			fail("agent_team.rate_limited", `Agent ${sourceAgentId} exceeded the Team ${eventType} rate limit`);
		}
	}

	#withinWindow(occurredAt: IsoDateTime): boolean {
		const now = Date.parse(this.#now());
		const occurred = Date.parse(occurredAt);
		return Number.isFinite(now) && Number.isFinite(occurred) && now - occurred < this.#policy.rateWindowMs;
	}

	#hasHandoffPath(fromAgentId: AgentId, targetAgentId: AgentId, workflowId: WorkflowId): boolean {
		const adjacency = new Map<AgentId, AgentId[]>();
		for (const message of this.#messages.values()) {
			if (message.workflowId !== workflowId || message.type !== "handoff_request" || !message.target.agentId) {
				continue;
			}
			const targets = adjacency.get(message.sourceAgentId) ?? [];
			targets.push(message.target.agentId);
			adjacency.set(message.sourceAgentId, targets);
		}
		const pending = [fromAgentId];
		const visited = new Set<AgentId>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || visited.has(current)) {
				continue;
			}
			if (current === targetAgentId) {
				return true;
			}
			visited.add(current);
			pending.push(...(adjacency.get(current) ?? []));
		}
		return false;
	}

	#append(event: TeamAuditEvent): void {
		if (event.sequence !== this.#sequence + 1) {
			fail("agent_team.invalid_sequence", "Agent Team event sequence must be contiguous");
		}
		this.#persistence?.append(event);
		this.#events.push(structuredClone(event));
		this.#sequence = event.sequence;
		if (event.type === "message.sent") {
			this.#messages.set(event.message.id, structuredClone(event.message));
		} else {
			this.#proposals.set(event.proposal.id, structuredClone(event.proposal));
		}
	}

	#restore(event: TeamAuditEvent): void {
		if (event.sequence !== this.#sequence + 1) {
			fail("agent_team.restore_sequence", "Persisted Agent Team event sequence is not contiguous");
		}
		this.#events.push(structuredClone(event));
		this.#sequence = event.sequence;
		if (event.type === "message.sent") {
			this.#messages.set(event.message.id, structuredClone(event.message));
		} else {
			this.#proposals.set(event.proposal.id, structuredClone(event.proposal));
		}
	}

	#validatePolicy(): void {
		const values = Object.values(this.#policy);
		if (values.some((value) => !Number.isInteger(value) || value < 1)) {
			fail("agent_team.invalid_policy", "Agent Team policy limits must be positive integers");
		}
	}
}
