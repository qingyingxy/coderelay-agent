import { describe, expect, it } from "vitest";
import {
	type AgentInstance,
	type AgentTeamPersistence,
	BUILTIN_AGENT_PROFILES,
	evaluateAgentTeamCandidate,
	GovernedAgentTeam,
	GovernedAgentTeamError,
	type ResourceUsage,
	type Task,
	type TeamAuditEvent,
	WORKFLOW_SCHEMA_VERSION,
	type Workflow,
} from "../../src/index.ts";

const NOW = "2026-07-29T00:00:00.000Z";
const ZERO_USAGE: ResourceUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	durationMs: 0,
};

function workflow(): Workflow {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 1,
		createdAt: NOW,
		updatedAt: NOW,
		id: "workflow-team",
		status: "executing",
		request: { text: "Coordinate a team", cwd: "C:/repo", attachments: [] },
		currentPlanId: "plan-team",
		rootTaskId: "task-root",
		budget: { maxConcurrentAgents: 3, maxTurns: 30 },
		usage: ZERO_USAGE,
	};
}

function task(id: string, status: Task["status"] = "running"): Task {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 1,
		createdAt: NOW,
		updatedAt: NOW,
		id,
		workflowId: "workflow-team",
		parentTaskId: id === "task-root" ? undefined : "task-root",
		kind: id === "task-root" ? "control" : "agent",
		accessMode: "read_only",
		title: id,
		description: `Execute ${id}`,
		status,
		dependencyIds: [],
		budget: { maxTurns: 10 },
		usage: ZERO_USAGE,
		attemptIds: [],
		verificationRequirements: [],
		modifications: [],
	};
}

function agent(
	id: string,
	taskId: string,
	attemptId: string,
	profile = BUILTIN_AGENT_PROFILES.explorer,
): AgentInstance {
	return {
		id,
		workflowId: "workflow-team",
		taskId,
		attemptId,
		profileName: profile.name,
		profile,
		profileSource: "builtin",
		scope: "task",
		backend: "rpc",
		status: "running",
		depth: 0,
		retryCount: 0,
		effectivePermissions: {
			read: true,
			write: profile.permissionCeiling.write,
			executeCommands: profile.permissionCeiling.executeCommands,
			network: false,
			allowedPaths: [],
			deniedPaths: [],
		},
		budget: profile.defaultBudget,
		usage: ZERO_USAGE,
		revision: 1,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

class MemoryTeamPersistence implements AgentTeamPersistence {
	readonly records: TeamAuditEvent[] = [];

	load(): readonly TeamAuditEvent[] {
		return structuredClone(this.records);
	}

	append(event: TeamAuditEvent): void {
		this.records.push(structuredClone(event));
	}
}

function harness(options: { readonly policy?: ConstructorParameters<typeof GovernedAgentTeam>[0]["policy"] } = {}) {
	let currentWorkflow = workflow();
	let tasks = [task("task-root", "pending"), task("task-a")];
	const agents = [agent("agent-a", "task-a", "attempt-a"), agent("agent-b", "task-a", "attempt-b")];
	const createdTasks: Task[] = [];
	let id = 0;
	let now = Date.parse(NOW);
	const persistence = new MemoryTeamPersistence();
	const team = new GovernedAgentTeam({
		createId: () => `team-${++id}`,
		now: () => new Date(now).toISOString(),
		policy: options.policy,
		persistence,
		agents: {
			get: (agentId) => agents.find(({ id: candidateId }) => candidateId === agentId),
			list: (workflowId) =>
				agents.filter((candidate) => workflowId === undefined || candidate.workflowId === workflowId),
		},
		authority: {
			getWorkflow: (workflowId) => (currentWorkflow.id === workflowId ? currentWorkflow : undefined),
			getTask: (taskId) => tasks.find(({ id: candidateId }) => candidateId === taskId),
			listTasks: (workflowId) => (workflowId === currentWorkflow.id ? tasks : []),
			createTask: (proposal) => {
				const created = {
					...task(`task-created-${createdTasks.length + 1}`, "pending"),
					sourceProposalId: proposal.id,
					recommendedAgentRole: proposal.requiredRole,
					accessMode: proposal.accessMode,
				};
				tasks = [...tasks, created];
				createdTasks.push(created);
				return created;
			},
		},
	});
	return {
		agents,
		createdTasks,
		persistence,
		team,
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
		replaceTask: (replacement: Task) => {
			tasks = tasks.map((candidate) => (candidate.id === replacement.id ? replacement : candidate));
		},
		setWorkflow: (replacement: Workflow) => {
			currentWorkflow = replacement;
		},
	};
}

function proposalDraft() {
	return {
		workflowId: "workflow-team",
		sourceAgentId: "agent-a",
		sourceTaskId: "task-a",
		sourceAttemptId: "attempt-a",
		objective: "Inspect the parser boundary",
		reason: "The current Task found an ambiguous parser branch",
		suggestedDependencyIds: ["task-a"],
		requiredRole: "explorer" as const,
		accessMode: "read_only" as const,
		riskLevel: "low" as const,
		risk: "Read-only inspection may be incomplete",
		verification: {
			kind: "review" as const,
			description: "Return evidence with exact file locations",
		},
	};
}

function metrics(overrides: Partial<ReturnType<typeof baseMetrics>> = {}) {
	return { ...baseMetrics(), ...overrides };
}

function baseMetrics() {
	return {
		runs: 3,
		successes: 2,
		successRate: 0.67,
		protocolValidityRate: 1,
		verificationIntegrityRate: 1,
		verificationPassRate: 0.67,
		reviewerEffectiveFindingRate: 0.5,
		repairSuccessRate: null,
		invalidDelegationRate: 0,
		handoffCompletenessRate: 1,
		decisionExplanationRate: 1,
		routingAccuracy: null,
		routingCoverage: null,
		expectedStrategyMatchRate: null,
		usage: { ...ZERO_USAGE, cost: 1 },
		averageCostPerSuccess: 0.5,
		averageDurationMs: 1_000,
		averageAgentCount: 1,
	};
}

describe("GovernedAgentTeam", () => {
	it("projects live Workflow Task state instead of copying a Team Task status", () => {
		const { team, replaceTask } = harness();

		expect(team.view("workflow-team").board.tasks.find(({ id }) => id === "task-a")?.status).toBe("running");
		replaceTask({ ...task("task-a", "succeeded"), revision: 2 });

		const view = team.view("workflow-team");
		expect(view.board.tasks.find(({ id }) => id === "task-a")?.status).toBe("succeeded");
		expect(view.members[0]).toMatchObject({
			role: "explorer",
			task: { id: "task-a", status: "succeeded" },
		});
	});

	it("persists bounded, addressed messages and restores the audit log", () => {
		const { team, persistence } = harness();
		const sent = team.sendMessage({
			workflowId: "workflow-team",
			sourceAgentId: "agent-a",
			target: { agentId: "agent-b" },
			taskId: "task-a",
			attemptId: "attempt-a",
			type: "question",
			body: "Which invariant protects this branch?",
		});

		expect(sent).toMatchObject({ sequence: 1, type: "question" });
		expect(persistence.records).toHaveLength(1);
		expect(
			() =>
				new GovernedAgentTeam({
					authority: {
						getWorkflow: () => workflow(),
						getTask: (taskId) => task(taskId),
						listTasks: () => [task("task-a")],
						createTask: () => {
							throw new Error("not used");
						},
					},
					agents: { get: () => undefined, list: () => [] },
					persistence,
				}),
		).not.toThrow();
	});

	it("blocks duplicate messages, message storms, terminal senders, and delegation cycles", () => {
		const { agents, team } = harness({
			policy: { maxMessagesPerAgentPerWindow: 2 },
		});
		const first = {
			workflowId: "workflow-team",
			sourceAgentId: "agent-a",
			target: { agentId: "agent-b" },
			taskId: "task-a",
			attemptId: "attempt-a",
			type: "handoff_request" as const,
			body: "Please inspect this boundary",
		};
		team.sendMessage(first);
		expect(() => team.sendMessage(first)).toThrowError(
			expect.objectContaining({ code: "agent_team.duplicate_message" }),
		);
		expect(() =>
			team.sendMessage({
				...first,
				sourceAgentId: "agent-b",
				target: { agentId: "agent-a" },
				attemptId: "attempt-b",
				body: "Delegate it back",
			}),
		).toThrowError(expect.objectContaining({ code: "agent_team.delegation_cycle" }));
		team.sendMessage({ ...first, type: "information", body: "Second allowed message" });
		expect(() =>
			team.sendMessage({ ...first, type: "question", body: "Third message in the same window" }),
		).toThrowError(expect.objectContaining({ code: "agent_team.rate_limited" }));

		agents[0] = { ...agents[0]!, status: "failed" };
		expect(() =>
			team.sendMessage({
				...first,
				type: "information",
				body: "Terminal send",
			}),
		).toThrowError(expect.objectContaining({ code: "agent_team.source_terminal" }));
	});

	it("keeps proposals non-authoritative until Controller acceptance and requires high-risk approval", () => {
		const { createdTasks, team } = harness();
		const proposal = team.submitProposal(proposalDraft());
		expect(proposal.status).toBe("pending");
		expect(createdTasks).toHaveLength(0);

		const accepted = team.decideProposal(proposal.id, {
			action: "accept",
			actor: "controller",
			reason: "Dependencies and role are admissible",
		});
		expect(accepted).toMatchObject({ status: "accepted", resultingTaskId: "task-created-1" });
		expect(createdTasks[0]).toMatchObject({
			sourceProposalId: proposal.id,
			recommendedAgentRole: "explorer",
		});

		const highRisk = team.submitProposal({
			...proposalDraft(),
			objective: "Modify parser ownership",
			requiredRole: "worker",
			accessMode: "writer",
			riskLevel: "high",
		});
		expect(
			team.decideProposal(highRisk.id, {
				action: "accept",
				actor: "scheduler",
				reason: "Policy admission passed",
			}).status,
		).toBe("approval_required");
		expect(createdTasks).toHaveLength(1);
		expect(
			team.decideProposal(highRisk.id, {
				action: "accept",
				actor: "controller",
				reason: "User approved the high-risk write",
				userApprovedHighRisk: true,
			}).status,
		).toBe("accepted");
		expect(createdTasks).toHaveLength(2);
	});

	it("blocks role escalation, duplicate proposals, and proposals outside executing Workflows", () => {
		const { createdTasks, setWorkflow, team } = harness();
		expect(() =>
			team.submitProposal({
				...proposalDraft(),
				requiredRole: "reviewer",
				accessMode: "writer",
			}),
		).toThrowError(expect.objectContaining({ code: "agent_team.writer_role_required" }));

		team.submitProposal(proposalDraft());
		expect(() => team.submitProposal(proposalDraft())).toThrowError(
			expect.objectContaining({ code: "agent_team.duplicate_proposal" }),
		);
		const coordinator = team.submitProposal({
			...proposalDraft(),
			objective: "Coordinate parser evidence",
			requiredRole: "coordinator",
		});
		team.decideProposal(coordinator.id, {
			action: "accept",
			actor: "controller",
			reason: "A read-only coordination pass is admissible",
		});
		expect(createdTasks[0]?.recommendedAgentRole).toBe("coordinator");
		expect(() =>
			team.submitProposal({
				...proposalDraft(),
				objective: "Create repair without Verification",
				requiredRole: "repair",
			}),
		).toThrowError(expect.objectContaining({ code: "agent_team.repair_proposal_denied" }));

		setWorkflow({ ...workflow(), status: "verifying" });
		expect(() =>
			team.submitProposal({
				...proposalDraft(),
				objective: "Another inspection",
			}),
		).toThrowError(expect.objectContaining({ code: "agent_team.workflow_not_executing" }));
	});

	it("does not make Agent Team a default candidate without repeated quality evidence", () => {
		expect(
			evaluateAgentTeamCandidate({
				baseline: metrics(),
				team: metrics({ runs: 1, successRate: 1, verificationPassRate: 1 }),
			}),
		).toMatchObject({
			eligible: false,
			findings: expect.arrayContaining([
				expect.objectContaining({ reasonCode: "agent_team.insufficient_evidence" }),
			]),
		});
		expect(
			evaluateAgentTeamCandidate({
				baseline: metrics(),
				team: metrics({
					successes: 3,
					successRate: 1,
					verificationPassRate: 1,
					usage: { ...ZERO_USAGE, cost: 1.5 },
					averageAgentCount: 3,
				}),
			}),
		).toEqual({ eligible: true, findings: [] });
	});

	it("uses typed governance errors", () => {
		const { team } = harness();
		expect(() => team.getProposal("missing")).not.toThrow();
		expect(() =>
			team.decideProposal("missing", {
				action: "reject",
				actor: "controller",
				reason: "Missing",
			}),
		).toThrow(GovernedAgentTeamError);
	});
});
