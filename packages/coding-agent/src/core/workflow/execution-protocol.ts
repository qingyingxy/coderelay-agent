import { randomUUID } from "node:crypto";
import type { SessionManager } from "../session-manager.ts";
import type { AgentInstance } from "../subagents/types.ts";
import type { PlanContent, PlanStep, WorkflowId } from "./types.ts";

export const EXECUTION_PROTOCOL_VERSION = "r19-v1";
export const EXECUTION_PROTOCOL_STAGES = ["before_main", "implementation", "after_main", "before_delivery"] as const;
export type ExecutionProtocolStage = (typeof EXECUTION_PROTOCOL_STAGES)[number];
export type ExecutionProtocolRole = "explorer" | "worker" | "reviewer";
export type ExecutionProtocolFailurePolicy = "fail_workflow" | "retry_once";

export interface ExecutionProtocolRequirement {
	readonly id: string;
	readonly stage: ExecutionProtocolStage;
	readonly role: ExecutionProtocolRole;
	readonly required: boolean;
	readonly minRuns: number;
	readonly maxRuns: number;
	readonly failurePolicy: ExecutionProtocolFailurePolicy;
}

export interface WorkflowExecutionProtocol {
	readonly version: typeof EXECUTION_PROTOCOL_VERSION;
	readonly name: string;
	readonly requirements: readonly ExecutionProtocolRequirement[];
}

export type ExecutionProtocolRunStatus = "running" | "succeeded" | "failed";

export interface ExecutionProtocolRun {
	readonly id: string;
	readonly requirementId: string;
	readonly role: ExecutionProtocolRole;
	readonly stage: ExecutionProtocolStage;
	readonly status: ExecutionProtocolRunStatus;
	readonly agentId?: string;
	readonly handoffId?: string;
	readonly summary?: string;
	readonly startedAt: string;
	readonly endedAt?: string;
}

export interface ExecutionProtocolView {
	readonly version: typeof EXECUTION_PROTOCOL_VERSION;
	readonly name: string;
	readonly workflowId: WorkflowId;
	readonly satisfied: boolean;
	readonly requirements: readonly (ExecutionProtocolRequirement & {
		readonly succeededRuns: number;
		readonly failedRuns: number;
		readonly satisfied: boolean;
	})[];
	readonly runs: readonly ExecutionProtocolRun[];
	readonly violations: readonly string[];
}

interface ExecutionProtocolCheckpoint {
	readonly kind: "checkpoint";
	readonly workflowId: WorkflowId;
	readonly protocol: WorkflowExecutionProtocol;
	readonly runs: readonly ExecutionProtocolRun[];
	readonly recordedAt: string;
}

function isCheckpoint(value: unknown): value is ExecutionProtocolCheckpoint {
	if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "checkpoint") {
		return false;
	}
	return (
		"workflowId" in value &&
		typeof value.workflowId === "string" &&
		"protocol" in value &&
		typeof value.protocol === "object" &&
		value.protocol !== null &&
		"runs" in value &&
		Array.isArray(value.runs)
	);
}

export function validateExecutionProtocol(protocol: WorkflowExecutionProtocol): readonly string[] {
	const violations: string[] = [];
	if (protocol.version !== EXECUTION_PROTOCOL_VERSION) {
		violations.push(`Unsupported execution protocol version: ${protocol.version}`);
	}
	if (!protocol.name.trim()) {
		violations.push("Execution protocol name is required");
	}
	const ids = new Set<string>();
	for (const requirement of protocol.requirements) {
		if (!requirement.id.trim()) {
			violations.push("Execution protocol requirement id is required");
		} else if (ids.has(requirement.id)) {
			violations.push(`Duplicate execution protocol requirement: ${requirement.id}`);
		}
		ids.add(requirement.id);
		if (!EXECUTION_PROTOCOL_STAGES.includes(requirement.stage)) {
			violations.push(`Unsupported execution protocol stage: ${requirement.stage}`);
		}
		const allowedStages: Readonly<Record<ExecutionProtocolRole, readonly ExecutionProtocolStage[]>> = {
			explorer: ["before_main"],
			worker: ["implementation"],
			reviewer: ["after_main", "before_delivery"],
		};
		if (!allowedStages[requirement.role].includes(requirement.stage)) {
			violations.push(`Execution protocol role ${requirement.role} cannot run at ${requirement.stage}`);
		}
		if (!Number.isInteger(requirement.minRuns) || requirement.minRuns < 0) {
			violations.push(`Requirement ${requirement.id} minRuns must be a non-negative integer`);
		}
		if (!Number.isInteger(requirement.maxRuns) || requirement.maxRuns < 1) {
			violations.push(`Requirement ${requirement.id} maxRuns must be a positive integer`);
		}
		if (requirement.minRuns > requirement.maxRuns) {
			violations.push(`Requirement ${requirement.id} minRuns cannot exceed maxRuns`);
		}
		if (requirement.required && requirement.minRuns < 1) {
			violations.push(`Required execution protocol requirement ${requirement.id} must run at least once`);
		}
	}
	return violations;
}

export function applyExecutionProtocolToPlan(content: PlanContent, protocol: WorkflowExecutionProtocol): PlanContent {
	const requiresWorker = protocol.requirements.some(
		({ required, role, stage }) => required && role === "worker" && stage === "implementation",
	);
	const requiresReviewer = protocol.requirements.some(
		({ required, role, stage }) =>
			required && role === "reviewer" && (stage === "after_main" || stage === "before_delivery"),
	);
	let steps: PlanStep[] = content.steps.map((step) => {
		if ((step.kind ?? "agent") !== "agent" || step.requiredAgentRole !== undefined) {
			return structuredClone(step);
		}
		const mutatesFiles = step.fileIntents.some(({ action }) => action !== "inspect");
		return {
			...structuredClone(step),
			requiredAgentRole: mutatesFiles ? "worker" : "explorer",
		};
	});
	if (requiresWorker && !steps.some(({ requiredAgentRole }) => requiredAgentRole === "worker")) {
		let workerStepId = "protocol-worker-implementation";
		let suffix = 2;
		const stepIds = new Set(steps.map(({ id }) => id));
		while (stepIds.has(workerStepId)) {
			workerStepId = `protocol-worker-implementation-${suffix++}`;
		}
		const readOnlyAgentStepIds = steps
			.filter(
				(step) =>
					(step.kind ?? "agent") === "agent" && step.requiredAgentRole !== "worker" && step.dependsOn.length === 0,
			)
			.map(({ id }) => id);
		steps = [
			...steps.map((step) =>
				step.kind === "command" ? { ...step, dependsOn: [...new Set([...step.dependsOn, workerStepId])] } : step,
			),
			{
				id: workerStepId,
				kind: "agent",
				requiredAgentRole: "worker",
				title: "Implement the approved change",
				description: content.goal,
				dependsOn: readOnlyAgentStepIds,
				fileIntents: [],
				verificationRequirementIds: [],
			},
		];
	}
	let verificationRequirements = structuredClone(content.verificationRequirements);
	if (requiresReviewer && !verificationRequirements.some(({ kind, required }) => kind === "review" && required)) {
		let requirementId = "protocol-review";
		let suffix = 2;
		const requirementIds = new Set(verificationRequirements.map(({ id }) => id));
		while (requirementIds.has(requirementId)) {
			requirementId = `protocol-review-${suffix++}`;
		}
		verificationRequirements = [
			...verificationRequirements,
			{
				id: requirementId,
				kind: "review",
				description: "Read-only Reviewer must approve the scoped delivery diff",
				required: true,
			},
		];
	}
	return {
		...structuredClone(content),
		steps,
		verificationRequirements,
	};
}

export class SessionExecutionProtocolRuntime {
	readonly #sessionManager: SessionManager;
	readonly #workflowId: WorkflowId;
	readonly #protocol: WorkflowExecutionProtocol;
	readonly #runs: ExecutionProtocolRun[];

	constructor(sessionManager: SessionManager, workflowId: WorkflowId, protocol: WorkflowExecutionProtocol) {
		const violations = validateExecutionProtocol(protocol);
		if (violations.length > 0) {
			throw new Error(violations.join("; "));
		}
		this.#sessionManager = sessionManager;
		this.#workflowId = workflowId;
		this.#protocol = structuredClone(protocol);
		this.#runs = this.#recoverRuns();
		this.#persist();
	}

	get protocol(): WorkflowExecutionProtocol {
		return structuredClone(this.#protocol);
	}

	requirements(stage?: ExecutionProtocolStage): readonly ExecutionProtocolRequirement[] {
		return this.#protocol.requirements
			.filter((requirement) => stage === undefined || requirement.stage === stage)
			.map((requirement) => structuredClone(requirement));
	}

	begin(requirementId: string, agentId?: string, stableRunId?: string): ExecutionProtocolRun {
		const requirement = this.#requireRequirement(requirementId);
		const runId = stableRunId ?? `protocol-run-${randomUUID()}`;
		const existing = this.#runs.find(({ id }) => id === runId);
		if (existing) {
			return structuredClone(existing);
		}
		const runCount = this.#runs.filter((run) => run.requirementId === requirement.id).length;
		if (runCount >= requirement.maxRuns) {
			throw new Error(`Execution protocol requirement ${requirement.id} exceeded maxRuns=${requirement.maxRuns}`);
		}
		const run: ExecutionProtocolRun = {
			id: runId,
			requirementId: requirement.id,
			role: requirement.role,
			stage: requirement.stage,
			status: "running",
			agentId,
			startedAt: new Date().toISOString(),
		};
		this.#runs.push(run);
		this.#persist();
		return structuredClone(run);
	}

	succeed(
		runId: string,
		input: { readonly agentId?: string; readonly handoffId?: string; readonly summary: string },
	): void {
		this.#settle(runId, "succeeded", input);
	}

	fail(runId: string, summary: string, agentId?: string): void {
		this.#settle(runId, "failed", { agentId, summary });
	}

	observeAgents(agents: readonly AgentInstance[]): void {
		for (const requirement of this.#protocol.requirements) {
			const matchingAgents = agents.filter(
				(agent) =>
					agent.profileName === requirement.role &&
					((agent.status === "idle" && agent.handoffId !== undefined) ||
						agent.status === "stopped" ||
						agent.status === "failed" ||
						agent.status === "interrupted"),
			);
			for (const agent of matchingAgents.slice(0, requirement.maxRuns)) {
				const runId = `protocol-agent-${requirement.id}-${agent.id}`;
				if (this.#runs.some(({ id }) => id === runId)) {
					continue;
				}
				const run = this.begin(requirement.id, agent.id, runId);
				if ((agent.status === "idle" || agent.status === "stopped") && agent.handoffId) {
					this.succeed(run.id, {
						agentId: agent.id,
						handoffId: agent.handoffId,
						summary: `${requirement.role} completed with a structured Handoff`,
					});
				} else {
					this.fail(run.id, `${requirement.role} ended without a structured Handoff`, agent.id);
				}
			}
		}
	}

	assertStageSatisfied(stage: ExecutionProtocolStage): void {
		const missing = this.view.requirements.filter(
			(requirement) => requirement.stage === stage && requirement.required && !requirement.satisfied,
		);
		if (missing.length > 0) {
			throw new Error(`Execution protocol stage ${stage} is incomplete: ${missing.map(({ id }) => id).join(", ")}`);
		}
	}

	get view(): ExecutionProtocolView {
		const requirements = this.#protocol.requirements.map((requirement) => {
			const runs = this.#runs.filter((run) => run.requirementId === requirement.id);
			const succeededRuns = runs.filter(({ status }) => status === "succeeded").length;
			const failedRuns = runs.filter(({ status }) => status === "failed").length;
			return {
				...structuredClone(requirement),
				succeededRuns,
				failedRuns,
				satisfied: !requirement.required || succeededRuns >= requirement.minRuns,
			};
		});
		const violations = requirements
			.filter(({ required, satisfied }) => required && !satisfied)
			.map(
				({ id, minRuns, succeededRuns }) =>
					`${id}: requires ${minRuns} successful run(s), observed ${succeededRuns}`,
			);
		return {
			version: this.#protocol.version,
			name: this.#protocol.name,
			workflowId: this.#workflowId,
			satisfied: violations.length === 0,
			requirements,
			runs: structuredClone(this.#runs),
			violations,
		};
	}

	#settle(
		runId: string,
		status: Extract<ExecutionProtocolRunStatus, "succeeded" | "failed">,
		input: { readonly agentId?: string; readonly handoffId?: string; readonly summary: string },
	): void {
		const index = this.#runs.findIndex(({ id }) => id === runId);
		if (index < 0) {
			throw new Error(`Execution protocol run ${runId} does not exist`);
		}
		const current = this.#runs[index];
		if (current.status !== "running") {
			if (current.status === status) {
				return;
			}
			throw new Error(`Execution protocol run ${runId} is already ${current.status}`);
		}
		this.#runs[index] = {
			...current,
			status,
			agentId: input.agentId ?? current.agentId,
			handoffId: input.handoffId,
			summary: input.summary,
			endedAt: new Date().toISOString(),
		};
		this.#persist();
	}

	#requireRequirement(requirementId: string): ExecutionProtocolRequirement {
		const requirement = this.#protocol.requirements.find(({ id }) => id === requirementId);
		if (!requirement) {
			throw new Error(`Execution protocol requirement ${requirementId} does not exist`);
		}
		return requirement;
	}

	#recoverRuns(): ExecutionProtocolRun[] {
		let runs: readonly ExecutionProtocolRun[] = [];
		for (const entry of this.#sessionManager.getBranch()) {
			if (
				entry.type !== "custom" ||
				entry.customType !== "workflow-execution-protocol" ||
				!isCheckpoint(entry.data)
			) {
				continue;
			}
			if (
				entry.data.workflowId === this.#workflowId &&
				entry.data.protocol.version === this.#protocol.version &&
				entry.data.protocol.name === this.#protocol.name
			) {
				runs = entry.data.runs;
			}
		}
		return [...structuredClone(runs)];
	}

	#persist(): void {
		const checkpoint: ExecutionProtocolCheckpoint = {
			kind: "checkpoint",
			workflowId: this.#workflowId,
			protocol: structuredClone(this.#protocol),
			runs: structuredClone(this.#runs),
			recordedAt: new Date().toISOString(),
		};
		this.#sessionManager.appendCustomEntry("workflow-execution-protocol", checkpoint);
	}
}
