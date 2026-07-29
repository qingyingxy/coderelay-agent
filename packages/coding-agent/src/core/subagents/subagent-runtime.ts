import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateAgentProfile } from "../workflow/agent-profile.ts";
import type { AgentCreationReasonCode, BackendSelectionReasonCode } from "../workflow/decision-reasons.ts";
import {
	assertBudgetAvailable,
	evaluateBudget,
	filterToolsByPermissions,
	inheritBudgetLimits,
	intersectPermissions,
	RuntimePolicyError,
	resolveEffectivePermissions,
	sumResourceUsage,
} from "../workflow/runtime-policy.ts";
import { DEFAULT_WORKFLOW_RUNTIME_REGISTRY, type WorkflowRuntimeRegistry } from "../workflow/runtime-registry.ts";
import type { AgentId, BudgetLimit, HandoffId, ResourceUsage } from "../workflow/types.ts";
import { DEFAULT_WRITER_LEASE_REGISTRY, type WriterLeaseRegistry } from "../workflow/writer-lease.ts";
import { AgentRegistry, AgentRegistryError } from "./agent-registry.ts";
import { compileAgentEnforcementPlan, type EnforcementMode, parseEnforcementMode } from "./enforcement-plan.ts";
import { GitWorktreeWorkspaceProvider } from "./git-worktree-workspace-provider.ts";
import { parseHandoff } from "./handoff.ts";
import { DEFAULT_WORKSPACE_INTEGRATION_QUEUE, type WorkspaceIntegrationQueue } from "./integration-queue.ts";
import {
	type ConflictResolutionAttempt,
	type IntegrationAttempt,
	MultiWriterIntegrationError,
	type MultiWriterIntegrationPersistence,
	MultiWriterIntegrationRuntime,
	type PostIntegrationVerifier,
} from "./multi-writer-integration.ts";
import {
	BaselineSandboxBackend,
	providerEnvironmentKeys,
	type SandboxBackend,
	type SandboxHandle,
} from "./sandbox-backend.ts";
import { resolveSubagentModelName } from "./subagent-model.ts";
import {
	SUBAGENT_CHECKPOINT_SCHEMA_VERSION,
	type SubagentCheckpoint,
	type SubagentPersistence,
	type SubagentPersistenceRecord,
} from "./subagent-persistence.ts";
import {
	compactTranscript,
	DEFAULT_SUBAGENT_RETENTION_POLICY,
	SecretRedactor,
	type SubagentRetentionPolicy,
	validateSubagentRetentionPolicy,
} from "./subagent-retention.ts";
import type { SubagentService } from "./subagent-service.ts";
import type {
	AgentBackend,
	AgentInstance,
	AgentRecoveryContext,
	AgentRunResult,
	AgentRuntimeEvent,
	AgentTranscriptEntry,
	AgentTranscriptEntryType,
	AgentTranscriptView,
	Handoff,
	RetrySubagentInput,
	SpawnSubagentInput,
	SubagentModification,
	SubagentSession,
	SubagentSessionFactory,
	WorkspaceArtifact,
	WorkspaceRecoveryVerification,
} from "./types.ts";
import type { WorkspaceProvider } from "./workspace-provider.ts";

const ACTIVE_AGENT_STATUSES = new Set(["starting", "running", "waiting"]);
const LIVE_AGENT_STATUSES = new Set(["starting", "idle", "running", "waiting", "stopping"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);

interface PendingMutation {
	readonly path: string;
	readonly operation: "edit" | "write";
}

interface RuntimeEventShape {
	readonly type?: unknown;
	readonly toolCallId?: unknown;
	readonly toolName?: unknown;
	readonly args?: unknown;
	readonly isError?: unknown;
	readonly message?: unknown;
}

export interface SubagentRuntimeOptions {
	readonly sessionFactory: SubagentSessionFactory;
	readonly inProcessSessionFactory?: SubagentSessionFactory;
	readonly registry?: AgentRegistry;
	readonly writerLeaseRegistry?: WriterLeaseRegistry;
	readonly runtimeRegistry?: WorkflowRuntimeRegistry;
	readonly createId?: (kind: "agent" | "handoff") => string;
	readonly now?: () => number;
	readonly maxAgents?: number;
	readonly writerLeaseTtlMs?: number;
	readonly persistence?: SubagentPersistence;
	readonly workspaceProvider?: WorkspaceProvider;
	readonly sandboxBackend?: SandboxBackend;
	readonly enforcementMode?: EnforcementMode;
	readonly integrationQueue?: WorkspaceIntegrationQueue;
	readonly multiWriter?: {
		readonly maxConcurrentWriters: number;
		readonly verifier: PostIntegrationVerifier;
		readonly persistence?: MultiWriterIntegrationPersistence;
		readonly integrationLeaseRegistry?: WriterLeaseRegistry;
		readonly integrationLeaseTtlMs?: number;
		readonly integrationLeaseWaitMs?: number;
	};
	readonly retentionPolicy?: SubagentRetentionPolicy;
	readonly redactor?: SecretRedactor;
}

export class SubagentRuntimeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SubagentRuntimeError";
		this.code = code;
	}
}

function zeroUsage(): ResourceUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		turns: 0,
		durationMs: 0,
	};
}

function mutationPath(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	const value = args as { path?: unknown; file_path?: unknown };
	if (typeof value.path === "string" && value.path.trim()) {
		return value.path;
	}
	return typeof value.file_path === "string" && value.file_path.trim() ? value.file_path : undefined;
}

function turnUsage(message: unknown): ResourceUsage | undefined {
	if (typeof message !== "object" || message === null || !("usage" in message)) {
		return undefined;
	}
	const usage = message.usage;
	if (typeof usage !== "object" || usage === null) {
		return undefined;
	}
	const values = usage as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cost?: unknown;
	};
	const cost =
		typeof values.cost === "object" &&
		values.cost !== null &&
		"total" in values.cost &&
		typeof values.cost.total === "number"
			? values.cost.total
			: 0;
	if (
		typeof values.input !== "number" ||
		typeof values.output !== "number" ||
		typeof values.cacheRead !== "number" ||
		typeof values.cacheWrite !== "number"
	) {
		return undefined;
	}
	return {
		inputTokens: values.input,
		outputTokens: values.output,
		cacheReadTokens: values.cacheRead,
		cacheWriteTokens: values.cacheWrite,
		cost,
		turns: 1,
		durationMs: 0,
	};
}

function decrementedDepthBudget(budget: BudgetLimit): BudgetLimit {
	if (budget.maxAgentDepth === undefined) {
		return budget;
	}
	return { ...budget, maxAgentDepth: Math.max(0, budget.maxAgentDepth - 1) };
}

export class SubagentRuntime implements SubagentService {
	readonly registry: AgentRegistry;
	readonly #sessionFactories: ReadonlyMap<AgentBackend, SubagentSessionFactory>;
	readonly #writerLeaseRegistry: WriterLeaseRegistry;
	readonly #runtimeRegistry: WorkflowRuntimeRegistry;
	readonly #createId: (kind: "agent" | "handoff") => string;
	readonly #now: () => number;
	readonly #maxAgents: number;
	readonly #writerLeaseTtlMs: number;
	readonly #persistence?: SubagentPersistence;
	readonly #workspaceProvider: WorkspaceProvider;
	readonly #sandboxBackend: SandboxBackend;
	readonly #enforcementMode: EnforcementMode;
	readonly #integrationQueue: WorkspaceIntegrationQueue;
	readonly #multiWriterIntegration: MultiWriterIntegrationRuntime | undefined;
	readonly #maxConcurrentWriters: number;
	readonly #retentionPolicy: SubagentRetentionPolicy;
	readonly #redactor: SecretRedactor;
	readonly #unsubscribeRegistry: () => void;
	readonly #resourceRecovery: Promise<void>;
	readonly #sessions = new Map<AgentId, SubagentSession>();
	readonly #spawnInputs = new Map<AgentId, SpawnSubagentInput>();
	readonly #workflowBudgets = new Map<string, BudgetLimit>();
	readonly #workflowPermissions = new Map<string, SpawnSubagentInput["workflowPermission"]>();
	readonly #runPromises = new Map<AgentId, Promise<AgentRunResult>>();
	readonly #lastResults = new Map<AgentId, AgentRunResult>();
	readonly #lastPrompts = new Map<AgentId, string>();
	readonly #interruptPromises = new Map<AgentId, Promise<AgentRunResult>>();
	readonly #interruptReasons = new Map<AgentId, string>();
	readonly #leaseIds = new Map<AgentId, string>();
	readonly #unregisterRuntime = new Map<AgentId, () => void>();
	readonly #unsubscribeEvents = new Map<AgentId, () => void>();
	readonly #interrupting = new Set<AgentId>();
	readonly #pendingMutations = new Map<AgentId, Map<string, PendingMutation>>();
	readonly #modifications = new Map<AgentId, SubagentModification[]>();
	readonly #incrementalUsage = new Map<AgentId, ResourceUsage>();
	readonly #transcripts = new Map<AgentId, AgentTranscriptEntry[]>();
	readonly #releasedWorkspaceAgents = new Set<AgentId>();
	readonly #sandboxHandles = new Map<AgentId, SandboxHandle>();
	readonly #workspaceRecovery = new Map<AgentId, WorkspaceRecoveryVerification>();
	#transcriptSequence = 0;
	#persistenceRecordsSinceCheckpoint = 0;

	constructor(options: SubagentRuntimeOptions) {
		const sessionFactories = new Map<AgentBackend, SubagentSessionFactory>([["rpc", options.sessionFactory]]);
		if (options.inProcessSessionFactory) {
			sessionFactories.set("in-process", options.inProcessSessionFactory);
		}
		this.#sessionFactories = sessionFactories;
		this.#now = options.now ?? Date.now;
		this.registry =
			options.registry ??
			new AgentRegistry({
				now: () => new Date(this.#now()).toISOString(),
			});
		this.#writerLeaseRegistry = options.writerLeaseRegistry ?? DEFAULT_WRITER_LEASE_REGISTRY;
		this.#runtimeRegistry = options.runtimeRegistry ?? DEFAULT_WORKFLOW_RUNTIME_REGISTRY;
		this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
		this.#maxAgents = options.maxAgents ?? 8;
		this.#writerLeaseTtlMs = options.writerLeaseTtlMs ?? 60_000;
		this.#persistence = options.persistence;
		this.#workspaceProvider = options.workspaceProvider ?? new GitWorktreeWorkspaceProvider();
		this.#sandboxBackend = options.sandboxBackend ?? new BaselineSandboxBackend();
		this.#enforcementMode = options.enforcementMode ?? parseEnforcementMode(process.env.PI_SUBAGENT_ENFORCEMENT);
		this.#integrationQueue = options.integrationQueue ?? DEFAULT_WORKSPACE_INTEGRATION_QUEUE;
		this.#maxConcurrentWriters = options.multiWriter?.maxConcurrentWriters ?? 1;
		if (!Number.isInteger(this.#maxConcurrentWriters) || this.#maxConcurrentWriters < 1) {
			throw new SubagentRuntimeError(
				"subagent.invalid_writer_concurrency",
				"Subagent maxConcurrentWriters must be a positive integer",
			);
		}
		this.#multiWriterIntegration = options.multiWriter
			? new MultiWriterIntegrationRuntime({
					workspaceProvider: this.#workspaceProvider,
					verifier: options.multiWriter.verifier,
					queue: this.#integrationQueue,
					persistence: options.multiWriter.persistence,
					integrationLeaseRegistry: options.multiWriter.integrationLeaseRegistry,
					integrationLeaseTtlMs: options.multiWriter.integrationLeaseTtlMs,
					integrationLeaseWaitMs: options.multiWriter.integrationLeaseWaitMs,
					now: () => new Date(this.#now()).toISOString(),
				})
			: undefined;
		this.#retentionPolicy = options.retentionPolicy ?? DEFAULT_SUBAGENT_RETENTION_POLICY;
		this.#redactor = options.redactor ?? new SecretRedactor();
		validateSubagentRetentionPolicy(this.#retentionPolicy);
		if (!Number.isInteger(this.#maxAgents) || this.#maxAgents < 1) {
			throw new SubagentRuntimeError("subagent.invalid_max_agents", "Subagent maxAgents must be positive");
		}
		this.#restorePersistedState();
		if (this.#persistence?.compact && this.registry.list().length > 0) {
			this.#persistence.compact(this.#createCheckpoint());
		}
		this.#resourceRecovery = this.#recoverResources();
		this.#unsubscribeRegistry = this.registry.subscribe((event) => {
			if (event.type !== "progress") {
				this.#persistState(event);
			}
		});
	}

	availableSlots(workflowId: string): number {
		const liveAgents = this.registry.list(workflowId).filter(({ status }) => LIVE_AGENT_STATUSES.has(status));
		return Math.max(0, this.#maxAgents - liveAgents.length);
	}

	parallelWriterCapacity(): number {
		return this.#multiWriterIntegration ? this.#maxConcurrentWriters : 1;
	}

	integrationAttempts(workflowId?: string): readonly IntegrationAttempt[] {
		return (this.#multiWriterIntegration?.attempts() ?? []).filter(
			({ artifact }) => workflowId === undefined || artifact.workflowId === workflowId,
		);
	}

	conflictAttempts(workflowId?: string): readonly ConflictResolutionAttempt[] {
		return (this.#multiWriterIntegration?.conflicts() ?? []).filter(
			({ sourceArtifact }) => workflowId === undefined || sourceArtifact.workflowId === workflowId,
		);
	}

	async spawn(input: SpawnSubagentInput): Promise<AgentInstance> {
		await this.#resourceRecovery;
		const profileViolations = validateAgentProfile(input.profile);
		if (profileViolations.length > 0) {
			throw new SubagentRuntimeError(
				"subagent.invalid_profile",
				profileViolations.map(({ message }) => message).join("; "),
			);
		}
		const liveAgents = this.registry.list(input.workflowId).filter(({ status }) => LIVE_AGENT_STATUSES.has(status));
		if (liveAgents.length >= this.#maxAgents) {
			throw new SubagentRuntimeError(
				"subagent.agent_limit",
				`Workflow ${input.workflowId} reached the Agent limit ${this.#maxAgents}`,
			);
		}

		const parent = input.parentAgentId ? this.registry.get(input.parentAgentId) : undefined;
		if (input.parentAgentId && !parent) {
			throw new AgentRegistryError(
				"agent_registry.parent_missing",
				`Parent Agent ${input.parentAgentId} does not exist`,
			);
		}
		if (parent && !LIVE_AGENT_STATUSES.has(parent.status)) {
			throw new SubagentRuntimeError("subagent.parent_terminal", `Parent Agent ${parent.id} is ${parent.status}`);
		}
		if (parent?.budget.maxAgentDepth !== undefined && parent.budget.maxAgentDepth < 1) {
			throw new RuntimePolicyError(
				"runtime_policy.agent_depth",
				`Parent Agent ${parent.id} cannot spawn another Agent`,
			);
		}
		const depth = parent ? parent.depth + 1 : 1;
		const workflowBudget = inheritBudgetLimits(
			this.#workflowBudgets.get(input.workflowId) ?? input.workflowBudget,
			input.workflowBudget,
		);
		const existingWorkflowPermission = this.#workflowPermissions.get(input.workflowId);
		const workflowPermission = existingWorkflowPermission
			? intersectPermissions(existingWorkflowPermission, input.workflowPermission)
			: structuredClone(input.workflowPermission);
		const activeAgents = this.registry
			.list(input.workflowId)
			.filter(({ status }) => ACTIVE_AGENT_STATUSES.has(status)).length;
		assertBudgetAvailable(workflowBudget, zeroUsage(), {
			activeAgents: activeAgents + 1,
			agentDepth: depth,
		});

		const parentPermission = parent?.effectivePermissions ?? input.parentPermission;
		const parentBudget = parent ? decrementedDepthBudget(parent.budget) : input.parentBudget;
		const effectivePermissions = resolveEffectivePermissions({
			parent: parentPermission,
			profile: input.profile.permissionCeiling,
			workflow: workflowPermission,
			task: input.taskPermission,
		});
		const budget = inheritBudgetLimits(parentBudget, workflowBudget, input.taskBudget, input.profile.defaultBudget);
		const {
			backend,
			reason: backendReason,
			reasonCode: backendReasonCode,
		} = this.#selectBackend(input, effectivePermissions, budget);
		const creationReasonCode = this.#resolveCreationReasonCode(input);
		const sessionFactory = this.#sessionFactories.get(backend);
		if (!sessionFactory) {
			throw new SubagentRuntimeError("subagent.backend_unsupported", `Subagent backend ${backend} is unavailable`);
		}
		const toolNames = filterToolsByPermissions(input.profile.allowedTools, effectivePermissions).filter(
			(toolName) => toolName !== "bash" || effectivePermissions.network,
		);
		if (!this.#workflowBudgets.has(input.workflowId)) {
			this.#workflowBudgets.set(input.workflowId, workflowBudget);
		}
		if (!existingWorkflowPermission) {
			this.#workflowPermissions.set(input.workflowId, workflowPermission);
		}
		const agentId = this.#createId("agent");
		const modelName = resolveSubagentModelName(input.cwd, input.profile.model);
		const workspace = await this.#workspaceProvider.prepare({
			agentId,
			backend,
			write: effectivePermissions.write,
			input,
		});
		if (this.#enforcementMode === "strict" && effectivePermissions.write && workspace.assurance !== "isolated") {
			await this.#workspaceProvider.release(workspace);
			throw new SubagentRuntimeError(
				"workspace.strict_isolation_unavailable",
				"Strict Subagent enforcement requires an isolated Workspace for write access",
			);
		}
		const enforcementPlan = compileAgentEnforcementPlan({
			mode: this.#enforcementMode,
			backend,
			workspace,
			permissions: effectivePermissions,
			providerEnvironmentKeys: providerEnvironmentKeys(modelName),
		});
		let sandboxHandle: SandboxHandle;
		try {
			sandboxHandle = await this.#sandboxBackend.prepare({
				agentId,
				backend,
				plan: enforcementPlan,
			});
		} catch (error) {
			await this.#workspaceProvider.release(workspace).catch(() => undefined);
			throw error;
		}
		this.#sandboxHandles.set(agentId, sandboxHandle);
		const sandbox = await this.#sandboxBackend.verify(sandboxHandle);
		const timestamp = new Date(this.#now()).toISOString();
		this.registry.create({
			id: agentId,
			workflowId: input.workflowId,
			parentAgentId: input.parentAgentId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			profileName: input.profile.name,
			profile: structuredClone(input.profile),
			profileSource: input.profileSource ?? "runtime",
			profileSourcePath: input.profileSourcePath,
			scope: input.scope ?? "task",
			backend,
			backendReason,
			backendReasonCode,
			creationReasonCode,
			enforcementPlan,
			sandbox,
			workspace,
			status: "starting",
			depth,
			retryCount: input.retryCount ?? 0,
			retryOfAgentId: input.retryOfAgentId,
			recoveryOfAgentId: input.recoveryOfAgentId,
			recoveryContext: input.recoveryContext,
			dependencyArtifactIds: input.dependencyArtifactIds ? [...input.dependencyArtifactIds] : undefined,
			effectivePermissions,
			budget,
			usage: zeroUsage(),
			revision: 0,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const session = sessionFactory.create({
			cwd: workspace.path,
			profile: input.profile,
			modelName,
			toolNames,
			effectivePermissions,
			budget,
			enforcementPlan,
			sandbox,
			environment: sandboxHandle.environment,
		});
		this.#sessions.set(agentId, session);
		this.#spawnInputs.set(
			agentId,
			structuredClone({
				...input,
				workflowBudget,
				workflowPermission,
			}),
		);
		this.#pendingMutations.set(agentId, new Map());
		this.#modifications.set(agentId, []);
		this.#incrementalUsage.set(agentId, zeroUsage());
		this.#transcripts.set(agentId, []);
		this.#unsubscribeEvents.set(
			agentId,
			session.onEvent((event) => this.#handleSessionEvent(agentId, event)),
		);
		try {
			await session.start();
			this.registry.setSession(agentId, await session.getSessionId());
			this.registry.transition(agentId, "idle");
			this.#unregisterRuntime.set(
				agentId,
				this.#runtimeRegistry.register({
					id: `subagent:${agentId}`,
					kind: "agent",
					workflowId: input.workflowId,
					taskId: input.taskId,
					stop: async (reason) => {
						await this.interrupt(agentId, reason);
					},
				}),
			);
			return this.#requireAgent(agentId);
		} catch (error) {
			const message = this.#redactor.redactText(error instanceof Error ? error.message : String(error));
			this.registry.fail(agentId, message);
			await session.stop().catch(() => undefined);
			await this.#cleanupAgent(agentId);
			throw new SubagentRuntimeError("subagent.start_failed", message);
		}
	}

	reserveWriter(agentId: AgentId): string | undefined {
		const agent = this.#requireAgent(agentId);
		if (!agent.effectivePermissions.write) {
			return undefined;
		}
		const existing = this.#leaseIds.get(agentId);
		if (existing) {
			this.#writerLeaseRegistry.renew(existing, this.#writerLeaseTtlMs);
			return existing;
		}
		const input = this.#requireInput(agentId);
		const lease = this.#writerLeaseRegistry.acquire({
			workspace:
				this.#multiWriterIntegration && agent.workspace?.assurance === "isolated"
					? agent.workspace.id
					: (agent.workspace?.repositoryIdentity ?? input.cwd),
			workflowId: agent.workflowId,
			taskId: agent.taskId,
			attemptId: agent.attemptId,
			ttlMs: this.#writerLeaseTtlMs,
		});
		this.#leaseIds.set(agentId, lease.id);
		return lease.id;
	}

	async send(agentId: AgentId, message: string): Promise<void> {
		if (!message.trim()) {
			throw new SubagentRuntimeError("subagent.message_required", "Subagent message is required");
		}
		const agent = this.#requireAgent(agentId);
		const session = this.#requireSession(agentId);
		if (agent.status === "running" || agent.status === "waiting") {
			await session.steer(message);
			this.#recordTranscript(agentId, "steer", message);
			this.registry.steered(agentId, "Steering message sent");
			if (agent.status === "waiting") {
				this.registry.transition(agentId, "running", "Agent resumed");
			}
			return;
		}
		if (agent.status !== "idle") {
			throw new SubagentRuntimeError("subagent.not_sendable", `Agent ${agentId} is ${agent.status}`);
		}
		if (this.#lastResults.has(agentId)) {
			throw new SubagentRuntimeError(
				"subagent.run_terminal",
				`Agent ${agentId} already completed its Task; spawn or retry a distinct Agent`,
			);
		}
		const input = this.#requireInput(agentId);
		const activeAgents = this.registry
			.list(agent.workflowId)
			.filter(({ id, status }) => id !== agentId && ACTIVE_AGENT_STATUSES.has(status)).length;
		const workflowUsage = sumResourceUsage(this.registry.list(agent.workflowId).map(({ usage }) => usage));
		assertBudgetAvailable(input.workflowBudget, workflowUsage, {
			activeAgents: activeAgents + 1,
			agentDepth: agent.depth,
		});
		this.reserveWriter(agentId);
		this.#lastPrompts.set(agentId, message);
		this.#recordTranscript(agentId, "prompt", message);
		this.#pendingMutations.set(agentId, new Map());
		this.#modifications.set(agentId, []);
		this.#incrementalUsage.set(agentId, zeroUsage());
		this.registry.transition(agentId, "running");
		const startedAt = this.#now();
		const timeoutMs = agent.budget.maxDurationMs ?? 300_000;
		const idlePromise = session.waitForIdle(timeoutMs);
		try {
			await session.prompt(message);
		} catch (error) {
			await this.#failRun(agentId, error, startedAt);
			throw error;
		}
		const runPromise = this.#settleRun(agentId, idlePromise, startedAt);
		this.#runPromises.set(agentId, runPromise);
	}

	async resume(agentId: AgentId, message: string): Promise<void> {
		if (!message.trim()) {
			throw new SubagentRuntimeError("subagent.message_required", "Resume message is required");
		}
		const agent = this.#requireAgent(agentId);
		if (agent.status !== "idle" || !agent.handoffId || !this.#lastResults.has(agentId)) {
			throw new SubagentRuntimeError("subagent.resume_not_allowed", `Agent ${agentId} is not terminal`);
		}
		if (agent.sessionReleasedAt || !this.#sessions.has(agentId)) {
			throw new SubagentRuntimeError("subagent.resume_unavailable", `Agent ${agentId} Session was released`);
		}
		this.registry.resume(agentId, message);
		this.#lastResults.delete(agentId);
		this.#recordTranscript(agentId, "resume", message);
		await this.send(agentId, message);
	}

	async wait(agentId: AgentId): Promise<AgentRunResult> {
		const run = this.#runPromises.get(agentId);
		if (run) {
			return structuredClone(await run);
		}
		const result = this.#lastResults.get(agentId);
		if (result) {
			return structuredClone(result);
		}
		throw new SubagentRuntimeError("subagent.no_run", `Agent ${agentId} has no run to wait for`);
	}

	async interrupt(agentId: AgentId, reason = "Interrupted by parent"): Promise<AgentRunResult> {
		const existingPromise = this.#interruptPromises.get(agentId);
		if (existingPromise) {
			return structuredClone(await existingPromise);
		}
		const interruptPromise = this.#interrupt(agentId, reason).finally(() => {
			this.#interruptPromises.delete(agentId);
			this.#interruptReasons.delete(agentId);
		});
		this.#interruptPromises.set(agentId, interruptPromise);
		return structuredClone(await interruptPromise);
	}

	async #interrupt(agentId: AgentId, reason: string): Promise<AgentRunResult> {
		const agent = this.#requireAgent(agentId);
		const safeReason = this.#redactor.redactText(reason);
		const existingResult = this.#lastResults.get(agentId);
		if (existingResult && agent.status === "idle") {
			await this.release(agentId);
			return structuredClone(existingResult);
		}
		if (agent.status === "stopped" || agent.status === "interrupted" || agent.status === "failed") {
			return structuredClone(
				existingResult ?? {
					agentId,
					status: agent.status === "failed" ? "failed" : "interrupted",
					usage: agent.usage,
					modifications: [],
					error: agent.lastError ?? safeReason,
				},
			);
		}
		this.#interrupting.add(agentId);
		this.#interruptReasons.set(agentId, safeReason);
		this.#recordTranscript(agentId, "interrupt", safeReason);
		if (agent.status !== "stopping") {
			this.registry.transition(agentId, "stopping", safeReason);
		}
		const session = this.#requireSession(agentId);
		if (this.#runPromises.has(agentId)) {
			await session.abort();
			return this.wait(agentId);
		}
		await session.stop();
		this.#releaseWriter(agentId);
		this.registry.transition(agentId, "stopped", safeReason);
		await this.#cleanupAgent(agentId);
		const result: AgentRunResult = {
			agentId,
			status: "interrupted",
			usage: agent.usage,
			modifications: [],
			artifact: agent.artifact,
			error: safeReason,
		};
		this.#lastResults.set(agentId, result);
		return structuredClone(result);
	}

	async retry(agentId: AgentId, input: RetrySubagentInput): Promise<AgentInstance> {
		await this.#resourceRecovery;
		const source = this.#requireAgent(agentId);
		if (source.status !== "failed" && source.status !== "interrupted" && source.status !== "stopped") {
			throw new SubagentRuntimeError("subagent.retry_not_allowed", `Agent ${agentId} is ${source.status}`);
		}
		const maximum = source.budget.maxRetries ?? 0;
		const recoveryReason = input.recoveryReason?.trim();
		if (!recoveryReason && source.retryCount >= maximum) {
			throw new RuntimePolicyError(
				"runtime_policy.retry_exhausted",
				`Agent ${agentId} exhausted ${maximum} retries`,
			);
		}
		const existingRetry = this.registry
			.list(source.workflowId)
			.find((agent) =>
				recoveryReason ? agent.recoveryOfAgentId === source.id : agent.retryOfAgentId === source.id,
			);
		if (existingRetry) {
			throw new RuntimePolicyError(
				recoveryReason ? "runtime_policy.recovery_exists" : "runtime_policy.retry_exists",
				`Agent ${agentId} already has ${recoveryReason ? "recovery" : "retry"} Agent ${existingRetry.id}`,
			);
		}
		const spawnInput = this.#requireInput(agentId);
		let recoveryContext = recoveryReason ? await this.#buildRecoveryContext(source, recoveryReason) : undefined;
		if (recoveryContext?.artifact && source.workspace?.kind === "git-worktree") {
			try {
				await this.#workspaceProvider.release(source.workspace);
				this.#releasedWorkspaceAgents.add(source.id);
				recoveryContext = {
					...recoveryContext,
					workspace: {
						status: "artifact-only",
						checkedAt: new Date(this.#now()).toISOString(),
						details: [...recoveryContext.workspace.details, "Source Worktree released after Artifact capture"],
					},
				};
			} catch (error) {
				recoveryContext = {
					...recoveryContext,
					workspace: {
						...recoveryContext.workspace,
						details: [
							...recoveryContext.workspace.details,
							`Source Worktree retained because release failed: ${this.#redactor.redactText(error instanceof Error ? error.message : String(error))}`,
						],
					},
				};
			}
		}
		const retried = await this.spawn({
			...spawnInput,
			attemptId: input.attemptId,
			retryCount: recoveryReason ? source.retryCount : source.retryCount + 1,
			retryOfAgentId: recoveryReason ? undefined : source.id,
			recoveryOfAgentId: recoveryReason ? source.id : undefined,
			recoveryContext,
		});
		if (input.autoStart ?? true) {
			const prompt = this.#lastPrompts.get(agentId);
			if (!prompt) {
				throw new SubagentRuntimeError("subagent.retry_prompt_missing", `Agent ${agentId} has no prompt to retry`);
			}
			await this.send(
				retried.id,
				recoveryContext ? `${this.#formatRecoveryContext(recoveryContext)}\n\n${prompt}` : prompt,
			);
		}
		return retried;
	}

	list(workflowId?: string): readonly AgentInstance[] {
		return this.registry.list(workflowId);
	}

	get(agentId: AgentId): AgentInstance | undefined {
		return this.registry.get(agentId);
	}

	getHandoff(handoffId: HandoffId): Handoff | undefined {
		return this.registry.getHandoff(handoffId);
	}

	events(agentId?: AgentId): readonly AgentRuntimeEvent[] {
		return this.registry.events(agentId);
	}

	getTranscript(agentId: AgentId): AgentTranscriptView {
		const agent = this.#requireAgent(agentId);
		return {
			agentId,
			sessionId: agent.sessionId,
			backend: agent.backend,
			released: agent.sessionReleasedAt !== undefined,
			entries: structuredClone(this.#transcripts.get(agentId) ?? []),
		};
	}

	subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
		return this.registry.subscribe(listener);
	}

	async release(agentId: AgentId): Promise<void> {
		const agent = this.#requireAgent(agentId);
		if (agent.status === "running" || agent.status === "waiting" || agent.status === "stopping") {
			throw new SubagentRuntimeError("subagent.session_active", `Agent ${agentId} Session is active`);
		}
		if (agent.sessionReleasedAt && (!agent.workspace || this.#releasedWorkspaceAgents.has(agent.id))) {
			return;
		}
		await this.#sessions.get(agentId)?.stop();
		await this.#cleanupAgent(agentId);
	}

	async cancelWorkflow(workflowId: string, reason: string): Promise<readonly AgentRunResult[]> {
		return Promise.all(
			this.registry
				.list(workflowId)
				.filter(({ status }) => LIVE_AGENT_STATUSES.has(status))
				.map(({ id }) => this.interrupt(id, reason)),
		);
	}

	async dispose(): Promise<void> {
		await this.#resourceRecovery.catch(() => undefined);
		await Promise.all(
			this.registry
				.list()
				.filter(({ status }) => LIVE_AGENT_STATUSES.has(status))
				.map(({ id, handoffId }) =>
					(handoffId ? this.release(id) : this.interrupt(id, "Subagent Runtime disposed")).catch(() => undefined),
				),
		);
		this.#unsubscribeRegistry();
	}

	async #settleRun(agentId: AgentId, idlePromise: Promise<void>, startedAt: number): Promise<AgentRunResult> {
		const session = this.#requireSession(agentId);
		try {
			await idlePromise;
			const usage = await session.getUsage();
			const completedUsage = { ...usage, durationMs: Math.max(0, this.#now() - startedAt) };
			this.registry.setUsage(agentId, completedUsage);
			if (this.#interrupting.has(agentId)) {
				const reason = this.#interruptReasons.get(agentId) ?? "Agent interrupted";
				this.#releaseWriter(agentId);
				this.registry.transition(agentId, "interrupted", reason);
				await session.stop();
				await this.#cleanupAgent(agentId);
				const interrupted: AgentRunResult = {
					agentId,
					status: "interrupted",
					usage: completedUsage,
					modifications: this.#modifications.get(agentId) ?? [],
					error: reason,
				};
				this.#lastResults.set(agentId, interrupted);
				return structuredClone(interrupted);
			}
			const agent = this.#requireAgent(agentId);
			const evaluation = evaluateBudget(agent.budget, completedUsage);
			const input = this.#requireInput(agentId);
			const workflowUsage = sumResourceUsage(this.registry.list(agent.workflowId).map(({ usage }) => usage));
			const overruns = [...evaluation.exceeded, ...evaluateBudget(input.workflowBudget, workflowUsage).exceeded];
			if (overruns.length > 0) {
				const dimensions = [...new Set(overruns.map(({ dimension }) => dimension))];
				throw new RuntimePolicyError(
					"runtime_policy.budget_exhausted",
					`Agent ${agentId} exceeded ${dimensions.join(", ")}`,
					overruns,
				);
			}
			const text = await session.getLastAssistantText();
			if (!text) {
				throw new SubagentRuntimeError("subagent.output_missing", `Agent ${agentId} returned no output`);
			}
			const parsedHandoff = this.#redactor.redact(
				parseHandoff(text, {
					id: this.#createId("handoff"),
					workflowId: agent.workflowId,
					taskId: agent.taskId,
					attemptId: agent.attemptId,
					agentId,
					createdAt: new Date(this.#now()).toISOString(),
				}),
			);
			const artifact = await this.#finalizeWorkspace(agentId, parsedHandoff);
			const handoff: Handoff = artifact
				? {
						...parsedHandoff,
						changedFiles: artifact.changedFiles,
						verificationSummary: [
							...parsedHandoff.verificationSummary,
							`Workspace Artifact ${artifact.id} integrated`,
						],
					}
				: parsedHandoff;
			this.#recordTranscript(agentId, "assistant", text);
			this.registry.recordHandoff(agentId, handoff);
			this.#releaseWriter(agentId);
			if (this.#requireAgent(agentId).status === "waiting") {
				this.registry.transition(agentId, "running", "Agent resumed before completion");
			}
			this.registry.transition(agentId, "idle", handoff.conclusion);
			const result: AgentRunResult = {
				agentId,
				status: "completed",
				handoff,
				usage: completedUsage,
				modifications: [...(this.#modifications.get(agentId) ?? [])],
				artifact,
			};
			this.#lastResults.set(agentId, result);
			return structuredClone(result);
		} catch (error) {
			return this.#failRun(agentId, error, startedAt);
		} finally {
			this.#runPromises.delete(agentId);
			this.#interrupting.delete(agentId);
		}
	}

	async #failRun(agentId: AgentId, error: unknown, startedAt: number): Promise<AgentRunResult> {
		const fallbackMessage = this.#redactor.redactText(error instanceof Error ? error.message : String(error));
		const message = this.#interrupting.has(agentId)
			? (this.#interruptReasons.get(agentId) ?? fallbackMessage)
			: fallbackMessage;
		const session = this.#sessions.get(agentId);
		let usage = zeroUsage();
		if (session) {
			usage = await session.getUsage().catch(() => zeroUsage());
		}
		const completedUsage = { ...usage, durationMs: Math.max(0, this.#now() - startedAt) };
		this.registry.setUsage(agentId, completedUsage);
		const agent = this.#requireAgent(agentId);
		if (agent.status === "stopping") {
			this.registry.transition(agentId, "interrupted", message);
		} else if (agent.status !== "failed") {
			this.registry.fail(agentId, message);
		}
		this.#releaseWriter(agentId);
		await session?.stop().catch(() => undefined);
		await this.#cleanupAgent(agentId);
		const result: AgentRunResult = {
			agentId,
			status: this.#interrupting.has(agentId) ? "interrupted" : "failed",
			usage: completedUsage,
			modifications: [...(this.#modifications.get(agentId) ?? [])],
			artifact: this.#requireAgent(agentId).artifact,
			error: message,
		};
		this.#lastResults.set(agentId, result);
		return structuredClone(result);
	}

	#handleSessionEvent(agentId: AgentId, value: unknown): void {
		if (typeof value !== "object" || value === null) {
			return;
		}
		const event = value as RuntimeEventShape;
		const type = typeof event.type === "string" ? event.type : "";
		if (type === "tool_execution_start") {
			if (
				typeof event.toolCallId === "string" &&
				typeof event.toolName === "string" &&
				MUTATION_TOOLS.has(event.toolName)
			) {
				const path = mutationPath(event.args);
				if (path) {
					this.#pendingMutations.get(agentId)?.set(event.toolCallId, {
						path,
						operation: event.toolName === "write" ? "write" : "edit",
					});
				}
			}
			this.registry.progress(agentId, typeof event.toolName === "string" ? `Tool: ${event.toolName}` : "Tool call");
			this.#recordTranscript(
				agentId,
				"activity",
				typeof event.toolName === "string" ? `Tool: ${event.toolName}` : "Tool call",
			);
			return;
		}
		if (type === "tool_execution_end" && typeof event.toolCallId === "string") {
			const pending = this.#pendingMutations.get(agentId)?.get(event.toolCallId);
			this.#pendingMutations.get(agentId)?.delete(event.toolCallId);
			if (pending && event.isError !== true) {
				this.#modifications.get(agentId)?.push({
					path: pending.path,
					operation: pending.operation,
					toolCallId: event.toolCallId,
				});
			}
			return;
		}
		if (type === "turn_end") {
			const turn = turnUsage(event.message);
			if (!turn) {
				return;
			}
			const current = this.#incrementalUsage.get(agentId) ?? zeroUsage();
			const usage = sumResourceUsage([current, turn]);
			this.#incrementalUsage.set(agentId, usage);
			this.registry.setUsage(agentId, usage);
			const agent = this.#requireAgent(agentId);
			const input = this.#requireInput(agentId);
			const workflowUsage = sumResourceUsage(
				this.registry.list(agent.workflowId).map(({ usage: agentUsage }) => agentUsage),
			);
			const exceeded = [
				...evaluateBudget(agent.budget, usage).exceeded,
				...evaluateBudget(input.workflowBudget, workflowUsage).exceeded,
			];
			if (exceeded.length > 0) {
				const dimensions = [...new Set(exceeded.map(({ dimension }) => dimension))];
				void this.interrupt(agentId, `Budget exhausted: ${dimensions.join(", ")}`).catch(() => undefined);
			}
			return;
		}
		if (type === "message_update" || type === "auto_retry_start" || type === "tool_execution_update") {
			this.registry.progress(agentId, type);
		}
	}

	#releaseWriter(agentId: AgentId): void {
		const leaseId = this.#leaseIds.get(agentId);
		if (leaseId) {
			this.#writerLeaseRegistry.release(leaseId);
			this.#leaseIds.delete(agentId);
		}
	}

	async #cleanupAgent(agentId: AgentId): Promise<void> {
		this.#unsubscribeEvents.get(agentId)?.();
		this.#unsubscribeEvents.delete(agentId);
		this.#unregisterRuntime.get(agentId)?.();
		this.#unregisterRuntime.delete(agentId);
		this.#sessions.delete(agentId);
		const agent = this.registry.get(agentId);
		if (agent && !agent.sessionReleasedAt) {
			this.registry.releaseSession(agentId);
		}
		try {
			if (agent?.workspace) {
				await this.#workspaceProvider.release(agent.workspace);
				this.#releasedWorkspaceAgents.add(agent.id);
			}
		} finally {
			const sandboxHandle = this.#sandboxHandles.get(agentId);
			if (sandboxHandle) {
				await this.#sandboxBackend.release(sandboxHandle);
				this.#sandboxHandles.delete(agentId);
			}
		}
	}

	#recordTranscript(agentId: AgentId, type: AgentTranscriptEntryType, text: string): void {
		const entries = this.#transcripts.get(agentId);
		if (!entries) {
			return;
		}
		const entry: AgentTranscriptEntry = {
			sequence: ++this.#transcriptSequence,
			agentId,
			type,
			text: this.#redactor.redactText(text),
			occurredAt: new Date(this.#now()).toISOString(),
		};
		entries.push(entry);
		const released = this.registry.get(agentId)?.sessionReleasedAt !== undefined;
		this.#transcripts.set(agentId, [...compactTranscript(entries, this.#retentionPolicy, released, this.#now())]);
		this.#appendPersistence({ kind: "transcript", entry });
	}

	#selectBackend(
		input: SpawnSubagentInput,
		permissions: SpawnSubagentInput["parentPermission"],
		budget: BudgetLimit,
	): { backend: AgentBackend; reason: string; reasonCode: BackendSelectionReasonCode } {
		const inProcessSafe =
			input.profile.role !== "worker" &&
			!permissions.write &&
			!permissions.executeCommands &&
			!permissions.network &&
			!permissions.denyAllPaths &&
			permissions.allowedPaths.length === 0 &&
			permissions.deniedPaths.length === 0 &&
			budget.maxAgentDepth === 0;
		if (input.backend === "in-process") {
			if (!inProcessSafe) {
				throw new SubagentRuntimeError(
					"subagent.in_process_unsafe",
					"In-process Subagents must be read-only, offline, command-free, non-worker, and unable to nest",
				);
			}
			return {
				backend: "in-process",
				reason: "Explicit safe in-process request",
				reasonCode: "backend.explicit_in_process",
			};
		}
		if (input.backend === "auto" && inProcessSafe && this.#sessionFactories.has("in-process")) {
			return {
				backend: "in-process",
				reason: "Auto-selected for a statically safe read-only Agent",
				reasonCode: "backend.auto_safe_in_process",
			};
		}
		return {
			backend: "rpc",
			reasonCode: input.backend === "auto" ? "backend.auto_rpc_fallback" : "backend.default_rpc",
			reason:
				input.backend === "auto"
					? "RPC safety fallback because in-process was unavailable or ineligible"
					: "RPC is the default isolated backend",
		};
	}

	#resolveCreationReasonCode(input: SpawnSubagentInput): AgentCreationReasonCode {
		if (input.creationReasonCode) {
			return input.creationReasonCode;
		}
		if (input.recoveryOfAgentId) {
			return "agent.recovery_required";
		}
		if (input.retryOfAgentId) {
			return "agent.retry_requested";
		}
		if (input.profile.role === "reviewer") {
			return "agent.review_requested";
		}
		if (input.profile.role === "explorer") {
			return "agent.exploration_requested";
		}
		return "agent.delegation_requested";
	}

	#persistState(event: AgentRuntimeEvent): void {
		const agent = this.registry.get(event.agentId);
		if (!agent) {
			return;
		}
		if (event.type === "session_released") {
			this.#transcripts.set(agent.id, [
				...compactTranscript(this.#transcripts.get(agent.id) ?? [], this.#retentionPolicy, true, this.#now()),
			]);
		}
		this.#appendPersistence({
			kind: "state",
			agent,
			event,
			handoff: agent.handoffId ? this.registry.getHandoff(agent.handoffId) : undefined,
			spawnInput: this.#spawnInputs.get(agent.id),
		});
		if (event.type === "session_released" && this.#persistence?.compact) {
			this.#persistence.compact(this.#createCheckpoint());
			this.#persistenceRecordsSinceCheckpoint = 0;
		}
	}

	#restorePersistedState(): void {
		if (!this.#persistence || this.registry.list().length > 0) {
			return;
		}
		const records = this.#persistence.load();
		let checkpoint: SubagentCheckpoint | undefined;
		for (let index = records.length - 1; index >= 0; index--) {
			const record = records[index];
			if (record?.kind === "checkpoint") {
				checkpoint = record.checkpoint;
				break;
			}
		}
		const states = records.filter((record) => record.kind === "state");
		const latestAgents = new Map<AgentId, AgentInstance>();
		const handoffs = new Map<HandoffId, Handoff>();
		const events = new Map<string, AgentRuntimeEvent>();
		const spawnInputs = new Map<AgentId, SpawnSubagentInput>();
		const transcripts = new Map<AgentId, AgentTranscriptEntry[]>();
		if (checkpoint) {
			for (const agent of checkpoint.agents) {
				latestAgents.set(agent.id, agent);
			}
			for (const handoff of checkpoint.handoffs) {
				handoffs.set(handoff.id, handoff);
			}
			for (const event of checkpoint.events) {
				events.set(`${event.agentId}:${event.sequence}`, event);
			}
			for (const entry of checkpoint.transcripts) {
				const agentEntries = transcripts.get(entry.agentId) ?? [];
				agentEntries.push(entry);
				transcripts.set(entry.agentId, agentEntries);
			}
			for (const persisted of checkpoint.spawnInputs) {
				spawnInputs.set(persisted.agentId, persisted.input);
			}
		}
		for (const record of states) {
			latestAgents.set(record.agent.id, record.agent);
			events.set(`${record.event.agentId}:${record.event.sequence}`, record.event);
			if (record.handoff) {
				handoffs.set(record.handoff.id, record.handoff);
			}
			if (record.spawnInput) {
				spawnInputs.set(record.agent.id, record.spawnInput);
			}
		}
		const recoveredAt = new Date(this.#now()).toISOString();
		let sequence = Math.max(0, ...[...events.values()].map((event) => event.sequence));
		const recoveryEvents: AgentRuntimeEvent[] = [];
		const agents = [...latestAgents.values()].map((agent) => {
			const wasActive = ACTIVE_AGENT_STATUSES.has(agent.status) || agent.status === "stopping";
			const recovered: AgentInstance = {
				...agent,
				status: wasActive ? "interrupted" : agent.status,
				lastError: wasActive ? "Interrupted during Session recovery" : agent.lastError,
				sessionReleasedAt: agent.sessionReleasedAt ?? recoveredAt,
				updatedAt: recoveredAt,
			};
			if (wasActive) {
				recoveryEvents.push({
					sequence: ++sequence,
					agentId: recovered.id,
					workflowId: recovered.workflowId,
					taskId: recovered.taskId,
					attemptId: recovered.attemptId,
					type: "interrupted",
					eventName: "subagent_interrupted",
					occurredAt: recoveredAt,
					message: recovered.lastError,
				});
			}
			if (!agent.sessionReleasedAt) {
				recoveryEvents.push({
					sequence: ++sequence,
					agentId: recovered.id,
					workflowId: recovered.workflowId,
					taskId: recovered.taskId,
					attemptId: recovered.attemptId,
					type: "session_released",
					eventName: "subagent_session_released",
					occurredAt: recoveredAt,
				});
			}
			return recovered;
		});
		for (const event of recoveryEvents) {
			events.set(`${event.agentId}:${event.sequence}`, event);
		}
		this.registry.restore(
			agents,
			[...handoffs.values()],
			[...events.values()].sort((left, right) => left.sequence - right.sequence),
		);
		for (const agent of agents) {
			const spawnInput = spawnInputs.get(agent.id) ?? this.#reconstructSpawnInput(agent);
			if (!spawnInput) {
				continue;
			}
			this.#spawnInputs.set(agent.id, spawnInput);
			this.#workflowBudgets.set(
				agent.workflowId,
				inheritBudgetLimits(this.#workflowBudgets.get(agent.workflowId) ?? spawnInput.workflowBudget),
			);
			this.#workflowPermissions.set(
				agent.workflowId,
				this.#workflowPermissions.has(agent.workflowId)
					? intersectPermissions(this.#workflowPermissions.get(agent.workflowId)!, spawnInput.workflowPermission)
					: spawnInput.workflowPermission,
			);
		}
		for (const event of recoveryEvents) {
			const agent = this.registry.get(event.agentId);
			if (agent) {
				this.#appendPersistence({
					kind: "state",
					agent,
					event,
					handoff: agent.handoffId ? this.registry.getHandoff(agent.handoffId) : undefined,
					spawnInput: this.#spawnInputs.get(agent.id),
				});
			}
		}
		for (const agent of agents) {
			const handoff = agent.handoffId ? handoffs.get(agent.handoffId) : undefined;
			if (agent.status === "idle" && handoff) {
				this.#lastResults.set(agent.id, {
					agentId: agent.id,
					status: "completed",
					handoff,
					usage: agent.usage,
					modifications: [],
					artifact: agent.artifact,
				});
			} else if (agent.status === "failed" || agent.status === "interrupted" || agent.status === "stopped") {
				this.#lastResults.set(agent.id, {
					agentId: agent.id,
					status: agent.status === "failed" ? "failed" : "interrupted",
					usage: agent.usage,
					modifications: [],
					artifact: agent.artifact,
					error: agent.lastError,
				});
			}
		}
		for (const record of records) {
			if (record.kind === "transcript") {
				const entries = transcripts.get(record.entry.agentId) ?? [];
				if (!entries.some(({ sequence: existing }) => existing === record.entry.sequence)) {
					entries.push(record.entry);
				}
				transcripts.set(record.entry.agentId, entries);
			}
		}
		for (const agent of agents) {
			const entries = transcripts.get(agent.id) ?? [];
			const compacted = compactTranscript(
				entries.sort((left, right) => left.sequence - right.sequence),
				this.#retentionPolicy,
				agent.sessionReleasedAt !== undefined,
				this.#now(),
			);
			this.#transcripts.set(agent.id, [...compacted]);
			for (const entry of compacted) {
				this.#transcriptSequence = Math.max(this.#transcriptSequence, entry.sequence);
				if (entry.type === "prompt") {
					this.#lastPrompts.set(agent.id, entry.text);
				}
			}
		}
	}

	async #recoverResources(): Promise<void> {
		const agents = this.registry.list();
		const workspaces = agents
			.map(({ workspace }) => workspace)
			.filter((workspace): workspace is NonNullable<typeof workspace> => workspace !== undefined);
		await this.#workspaceProvider.recover?.(workspaces);
		for (const agent of agents) {
			if (!agent.workspace) {
				continue;
			}
			const verification = this.#workspaceProvider.validateRecovery
				? await this.#workspaceProvider.validateRecovery(agent.workspace, agent.artifact)
				: {
						status: "unavailable" as const,
						checkedAt: new Date(this.#now()).toISOString(),
						details: ["Workspace Provider does not implement recovery verification"],
					};
			this.#workspaceRecovery.set(agent.id, verification);
		}
		await this.#workspaceProvider.cleanupOrphans?.(new Set(workspaces.map(({ id }) => id)));
	}

	#appendPersistence(record: SubagentPersistenceRecord): void {
		if (!this.#persistence) {
			return;
		}
		this.#persistence.append(this.#redactor.redact(record));
		this.#persistenceRecordsSinceCheckpoint++;
		if (
			this.#persistence.compact &&
			this.#persistenceRecordsSinceCheckpoint >= this.#retentionPolicy.checkpointEveryRecords
		) {
			this.#persistence.compact(this.#createCheckpoint());
			this.#persistenceRecordsSinceCheckpoint = 0;
		}
	}

	#createCheckpoint(): SubagentCheckpoint {
		const agents = this.registry.list();
		return this.#redactor.redact({
			schemaVersion: SUBAGENT_CHECKPOINT_SCHEMA_VERSION,
			createdAt: new Date(this.#now()).toISOString(),
			agents,
			handoffs: this.registry.listHandoffs(),
			events: this.registry.events().slice(-this.#retentionPolicy.maxEvents),
			transcripts: agents.flatMap((agent) =>
				compactTranscript(
					this.#transcripts.get(agent.id) ?? [],
					this.#retentionPolicy,
					agent.sessionReleasedAt !== undefined,
					this.#now(),
				),
			),
			spawnInputs: agents.flatMap((agent) => {
				const input = this.#spawnInputs.get(agent.id);
				return input ? [{ agentId: agent.id, input }] : [];
			}),
		});
	}

	#reconstructSpawnInput(agent: AgentInstance): SpawnSubagentInput | undefined {
		if (!agent.profile || !agent.workspace) {
			return undefined;
		}
		return {
			workflowId: agent.workflowId,
			taskId: agent.taskId,
			attemptId: agent.attemptId,
			cwd: agent.workspace.repositoryRoot ?? agent.workspace.path,
			profile: agent.profile,
			profileSource: agent.profileSource,
			profileSourcePath: agent.profileSourcePath,
			scope: agent.scope,
			backend: agent.backend,
			creationReasonCode: agent.creationReasonCode,
			parentPermission: agent.effectivePermissions,
			workflowPermission: agent.effectivePermissions,
			taskPermission: agent.effectivePermissions,
			parentBudget: agent.budget,
			workflowBudget: agent.budget,
			taskBudget: agent.budget,
			retryCount: agent.retryCount,
			retryOfAgentId: agent.retryOfAgentId,
			recoveryOfAgentId: agent.recoveryOfAgentId,
			recoveryContext: agent.recoveryContext,
		};
	}

	async #buildRecoveryContext(source: AgentInstance, reason: string): Promise<AgentRecoveryContext> {
		let workspace = this.#workspaceRecovery.get(source.id);
		if (!workspace && source.workspace) {
			workspace = this.#workspaceProvider.validateRecovery
				? await this.#workspaceProvider.validateRecovery(source.workspace, source.artifact)
				: {
						status: "unavailable",
						checkedAt: new Date(this.#now()).toISOString(),
						details: ["Workspace Provider does not implement recovery verification"],
					};
			this.#workspaceRecovery.set(source.id, workspace);
		}
		workspace ??= {
			status: "unavailable",
			checkedAt: new Date(this.#now()).toISOString(),
			details: ["Source Agent has no persisted Workspace"],
		};
		let artifact = source.artifact;
		if (!artifact && source.workspace && workspace.status === "available" && this.#workspaceProvider.createArtifact) {
			try {
				artifact = await this.#workspaceProvider.createArtifact(source.workspace, []);
				if (artifact) {
					this.registry.setArtifact(source.id, artifact);
					this.#persistence?.compact?.(this.#createCheckpoint());
					workspace = {
						...workspace,
						details: [...workspace.details, `Captured interrupted changes as Artifact ${artifact.id}`],
					};
				}
			} catch (error) {
				workspace = {
					status: "invalid",
					checkedAt: new Date(this.#now()).toISOString(),
					details: [
						...workspace.details,
						`Failed to capture interrupted Workspace: ${this.#redactor.redactText(error instanceof Error ? error.message : String(error))}`,
					],
				};
			}
		}
		const transcript = this.#transcripts.get(source.id) ?? [];
		const lastPrompt = [...transcript].reverse().find(({ type }) => type === "prompt")?.text;
		const lastAssistantText = [...transcript].reverse().find(({ type }) => type === "assistant")?.text;
		let artifactPatch: string | undefined;
		if (artifact && workspace.status !== "invalid") {
			try {
				const patch = await readFile(artifact.patchPath, "utf8");
				const maximumPatchChars = 64 * 1024;
				artifactPatch =
					patch.length > maximumPatchChars
						? `${patch.slice(0, maximumPatchChars)}\n[Recovery Patch truncated by ${patch.length - maximumPatchChars} chars]`
						: patch;
			} catch (error) {
				workspace = {
					...workspace,
					details: [
						...workspace.details,
						`Artifact Patch could not be loaded into Recovery Context: ${this.#redactor.redactText(error instanceof Error ? error.message : String(error))}`,
					],
				};
			}
		}
		return this.#redactor.redact({
			sourceAgentId: source.id,
			sourceAttemptId: source.attemptId,
			reason,
			checkpointAt: new Date(this.#now()).toISOString(),
			lastPrompt,
			lastAssistantText,
			handoff: source.handoffId ? this.registry.getHandoff(source.handoffId) : undefined,
			artifact,
			artifactPatch,
			workspace,
		});
	}

	#formatRecoveryContext(context: AgentRecoveryContext): string {
		return [
			"Recovery Attempt context (stable persisted facts; revalidate before relying on them):",
			JSON.stringify(context),
		].join("\n");
	}

	async #finalizeWorkspace(agentId: AgentId, handoff: Handoff): Promise<WorkspaceArtifact | undefined> {
		const agent = this.#requireAgent(agentId);
		const workspace = agent.workspace;
		if (!workspace || !this.#workspaceProvider.createArtifact) {
			return undefined;
		}
		const created = await this.#workspaceProvider.createArtifact(workspace, this.#modifications.get(agentId) ?? []);
		if (!created) {
			return undefined;
		}
		const artifact: WorkspaceArtifact = {
			...created,
			workflowId: agent.workflowId,
			taskId: agent.taskId,
			attemptId: agent.attemptId,
			agentId: agent.id,
			dependencyArtifactIds: agent.dependencyArtifactIds ? [...agent.dependencyArtifactIds] : undefined,
		};
		this.registry.setArtifact(agentId, artifact);
		if (this.#multiWriterIntegration) {
			try {
				const integrated = await this.#multiWriterIntegration.integrate({ artifact, handoff });
				this.registry.setArtifact(agentId, integrated);
				return integrated;
			} catch (error) {
				const failed =
					error instanceof MultiWriterIntegrationError
						? error.artifact
						: {
								...artifact,
								status: "failed" as const,
								error: error instanceof Error ? error.message : String(error),
							};
				this.registry.setArtifact(agentId, failed);
				throw error;
			}
		}
		if (!this.#workspaceProvider.integrateArtifact) {
			return artifact;
		}
		try {
			const integrated = await this.#integrationQueue.run(artifact.repositoryIdentity, () =>
				this.#workspaceProvider.integrateArtifact!(artifact),
			);
			this.registry.setArtifact(agentId, integrated);
			return integrated;
		} catch (error) {
			this.registry.setArtifact(agentId, {
				...artifact,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	#requireAgent(agentId: AgentId): AgentInstance {
		const agent = this.registry.get(agentId);
		if (!agent) {
			throw new SubagentRuntimeError("subagent.agent_missing", `Agent ${agentId} does not exist`);
		}
		return agent;
	}

	#requireSession(agentId: AgentId): SubagentSession {
		const session = this.#sessions.get(agentId);
		if (!session) {
			throw new SubagentRuntimeError("subagent.session_missing", `Agent ${agentId} has no Session`);
		}
		return session;
	}

	#requireInput(agentId: AgentId): SpawnSubagentInput {
		const input = this.#spawnInputs.get(agentId);
		if (!input) {
			throw new SubagentRuntimeError("subagent.input_missing", `Agent ${agentId} has no spawn input`);
		}
		return input;
	}
}
