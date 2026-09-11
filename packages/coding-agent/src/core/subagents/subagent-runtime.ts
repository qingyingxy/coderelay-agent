import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { executeBashWithOperations } from "../bash-executor.ts";
import { createLocalBashOperations } from "../tools/bash.ts";
import { validateAgentProfile } from "../workflow/agent-profile.ts";
import type { AgentCreationReasonCode, BackendSelectionReasonCode } from "../workflow/decision-reasons.ts";
import { ExecutionWatchdog, type ExecutionWatchdogPolicy, watchdogBudget } from "../workflow/execution-watchdog.ts";
import type { ModelGateway } from "../workflow/model-gateway.ts";
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
import { HandoffValidationError, parseHandoff, STRUCTURED_HANDOFF_RETRY_INSTRUCTION } from "./handoff.ts";
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
	AgentBackendPolicy,
	AgentCommandDiagnostic,
	AgentInstance,
	AgentRecoveryContext,
	AgentRunResult,
	AgentRuntimeEvent,
	AgentTranscriptEntry,
	AgentTranscriptEntryType,
	AgentTranscriptView,
	ControlledVerificationRunner,
	Handoff,
	RetrySubagentInput,
	SpawnSubagentInput,
	SubagentModification,
	SubagentSession,
	SubagentSessionFactory,
	WorkspaceArtifact,
	WorkspaceRecoveryVerification,
} from "./types.ts";
import { formatWorkerExecutionContext } from "./worker-context.ts";
import type { WorkspaceProvider } from "./workspace-provider.ts";

const ACTIVE_AGENT_STATUSES = new Set(["starting", "running", "waiting"]);
const LIVE_AGENT_STATUSES = new Set(["starting", "idle", "running", "waiting", "stopping"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);
const COMMAND_DIAGNOSTIC_PREFIX = "Command diagnostic: ";
const WORKER_NO_PROGRESS_STEER_TURNS = 6;
const WORKER_NO_PROGRESS_STOP_TURNS = 20;
const DEFAULT_WORKER_NO_PROGRESS_STEER_MS = 60_000;
const DEFAULT_WORKER_NO_PROGRESS_STOP_MS = 150_000;
const DEFAULT_CONTROLLED_VERIFICATION_TIMEOUT_MS = 120_000;
const REVIEWER_FINALIZE_TURNS = 5;

interface PendingMutation {
	readonly path: string;
	readonly operation: "edit" | "write";
}

interface RuntimeEventShape {
	readonly type?: unknown;
	readonly toolCallId?: unknown;
	readonly toolName?: unknown;
	readonly args?: unknown;
	readonly result?: unknown;
	readonly isError?: unknown;
	readonly message?: unknown;
}

interface PendingCommand {
	readonly command: string;
}

interface ControlledVerificationState {
	readonly promise: Promise<void>;
}

interface ControlledVerificationRecord {
	readonly sequence: number;
	readonly diagnostic: AgentCommandDiagnostic;
}

interface RequiredVerificationProblem {
	readonly kind: "not_run" | "failed" | "stale";
	readonly command: string;
	readonly message: string;
}

const localVerificationOperations = createLocalBashOperations();

const defaultVerificationRunner: ControlledVerificationRunner = async (input) => {
	try {
		const result = await executeBashWithOperations(input.command, input.cwd, localVerificationOperations, {
			timeoutMs: input.timeoutMs,
			environment: input.environment,
		});
		return {
			exitCode: result.exitCode,
			output: result.output,
			timedOut: false,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			exitCode: undefined,
			output: message,
			timedOut: /^timeout:/i.test(message),
		};
	}
};

export interface SubagentRuntimeOptions {
	/** Host opt-in: replace cost/time/turn caps and no-edit heuristics with response/loop detection. */
	readonly executionWatchdog?: ExecutionWatchdogPolicy;
	readonly sessionFactory: SubagentSessionFactory;
	readonly inProcessSessionFactory?: SubagentSessionFactory;
	readonly registry?: AgentRegistry;
	readonly writerLeaseRegistry?: WriterLeaseRegistry;
	readonly runtimeRegistry?: WorkflowRuntimeRegistry;
	readonly createId?: (kind: "agent" | "handoff") => string;
	readonly now?: () => number;
	readonly maxAgents?: number;
	readonly maxAgentDurationMs?: number;
	readonly workerNoProgressSteerMs?: number;
	readonly workerNoProgressStopMs?: number;
	readonly controlledVerificationTimeoutMs?: number;
	readonly verificationRunner?: ControlledVerificationRunner;
	readonly defaultBackend?: AgentBackendPolicy;
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
	readonly modelGateway?: ModelGateway;
	readonly writeDeniedPaths?: readonly string[];
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

function commandText(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || !("command" in args)) {
		return undefined;
	}
	const command = args.command;
	return typeof command === "string" && command.trim() ? command : undefined;
}

function diagnosticOutput(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	let serialized: string;
	if (typeof value === "string") {
		serialized = value;
	} else {
		try {
			serialized = JSON.stringify(value);
		} catch {
			serialized = String(value);
		}
	}
	const maximumChars = 16 * 1024;
	return serialized.length > maximumChars
		? `[Earlier output truncated by ${serialized.length - maximumChars} chars]\n${serialized.slice(-maximumChars)}`
		: serialized;
}

function parseCommandDiagnostic(text: string): AgentCommandDiagnostic | undefined {
	if (!text.startsWith(COMMAND_DIAGNOSTIC_PREFIX)) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(text.slice(COMMAND_DIAGNOSTIC_PREFIX.length));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const diagnostic = value as Partial<AgentCommandDiagnostic>;
	if (
		typeof diagnostic.toolCallId !== "string" ||
		typeof diagnostic.command !== "string" ||
		(diagnostic.status !== "succeeded" && diagnostic.status !== "failed") ||
		(diagnostic.output !== undefined && typeof diagnostic.output !== "string") ||
		(diagnostic.source !== undefined && diagnostic.source !== "agent" && diagnostic.source !== "controlled")
	) {
		return undefined;
	}
	return {
		toolCallId: diagnostic.toolCallId,
		command: diagnostic.command,
		status: diagnostic.status,
		output: diagnostic.output,
		source: diagnostic.source,
	};
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
	readonly #executionWatchdog?: ExecutionWatchdogPolicy;
	readonly #watchdogs = new Map<AgentId, ExecutionWatchdog>();
	readonly registry: AgentRegistry;
	readonly #sessionFactories: ReadonlyMap<AgentBackend, SubagentSessionFactory>;
	readonly #writerLeaseRegistry: WriterLeaseRegistry;
	readonly #runtimeRegistry: WorkflowRuntimeRegistry;
	readonly #createId: (kind: "agent" | "handoff") => string;
	readonly #now: () => number;
	readonly #maxAgents: number;
	readonly #maxAgentDurationMs: number | undefined;
	readonly #workerNoProgressSteerMs: number;
	readonly #workerNoProgressStopMs: number;
	readonly #controlledVerificationTimeoutMs: number;
	readonly #verificationRunner: ControlledVerificationRunner;
	readonly #defaultBackend: AgentBackendPolicy | undefined;
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
	readonly #modelGateway: ModelGateway | undefined;
	readonly #writeDeniedPaths: readonly string[];
	readonly #unsubscribeRegistry: () => void;
	readonly #resourceRecovery: Promise<void>;
	readonly #sessions = new Map<AgentId, SubagentSession>();
	readonly #spawnInputs = new Map<AgentId, SpawnSubagentInput>();
	readonly #workflowBudgets = new Map<string, BudgetLimit>();
	readonly #workflowPermissions = new Map<string, SpawnSubagentInput["workflowPermission"]>();
	readonly #runPromises = new Map<AgentId, Promise<AgentRunResult>>();
	readonly #lastResults = new Map<AgentId, AgentRunResult>();
	readonly #lastPrompts = new Map<AgentId, string>();
	readonly #originalPrompts = new Map<AgentId, string>();
	readonly #interruptPromises = new Map<AgentId, Promise<AgentRunResult>>();
	readonly #interruptReasons = new Map<AgentId, string>();
	readonly #leaseIds = new Map<AgentId, string>();
	readonly #unregisterRuntime = new Map<AgentId, () => void>();
	readonly #unsubscribeEvents = new Map<AgentId, () => void>();
	readonly #interrupting = new Set<AgentId>();
	readonly #pendingMutations = new Map<AgentId, Map<string, PendingMutation>>();
	readonly #pendingCommands = new Map<AgentId, Map<string, PendingCommand>>();
	readonly #commandDiagnostics = new Map<AgentId, AgentCommandDiagnostic[]>();
	readonly #modifications = new Map<AgentId, SubagentModification[]>();
	readonly #incrementalUsage = new Map<AgentId, ResourceUsage>();
	readonly #transcripts = new Map<AgentId, AgentTranscriptEntry[]>();
	readonly #releasedWorkspaceAgents = new Set<AgentId>();
	readonly #sandboxHandles = new Map<AgentId, SandboxHandle>();
	readonly #workspaceRecovery = new Map<AgentId, WorkspaceRecoveryVerification>();
	readonly #noProgressSteered = new Set<AgentId>();
	readonly #noProgressStopped = new Set<AgentId>();
	readonly #verificationCompleteSteered = new Set<AgentId>();
	readonly #reviewerFinalizeSteered = new Set<AgentId>();
	readonly #verificationModificationCounts = new Map<AgentId, Map<string, number>>();
	readonly #verificationEnvironments = new Map<AgentId, Readonly<Record<string, string>>>();
	readonly #controlledVerifications = new Map<AgentId, Map<string, ControlledVerificationState>>();
	readonly #controlledVerificationResults = new Map<AgentId, Map<string, ControlledVerificationRecord>>();
	readonly #noProgressTimers = new Map<AgentId, readonly ReturnType<typeof setTimeout>[]>();
	#transcriptSequence = 0;
	#controlledVerificationSequence = 0;
	#persistenceRecordsSinceCheckpoint = 0;
	#disposePromise: Promise<void> | undefined;

	constructor(options: SubagentRuntimeOptions) {
		this.#executionWatchdog = options.executionWatchdog;
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
		this.#maxAgentDurationMs = options.maxAgentDurationMs;
		this.#workerNoProgressSteerMs = options.workerNoProgressSteerMs ?? DEFAULT_WORKER_NO_PROGRESS_STEER_MS;
		this.#workerNoProgressStopMs = options.workerNoProgressStopMs ?? DEFAULT_WORKER_NO_PROGRESS_STOP_MS;
		this.#controlledVerificationTimeoutMs =
			options.controlledVerificationTimeoutMs ?? DEFAULT_CONTROLLED_VERIFICATION_TIMEOUT_MS;
		this.#verificationRunner = options.verificationRunner ?? defaultVerificationRunner;
		this.#defaultBackend = options.defaultBackend;
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
		this.#modelGateway = options.modelGateway;
		this.#writeDeniedPaths = [
			...new Set((options.writeDeniedPaths ?? []).map((path) => path.trim()).filter(Boolean)),
		];
		validateSubagentRetentionPolicy(this.#retentionPolicy);
		if (!Number.isInteger(this.#maxAgents) || this.#maxAgents < 1) {
			throw new SubagentRuntimeError("subagent.invalid_max_agents", "Subagent maxAgents must be positive");
		}
		if (
			this.#maxAgentDurationMs !== undefined &&
			(!Number.isInteger(this.#maxAgentDurationMs) || this.#maxAgentDurationMs < 1)
		) {
			throw new SubagentRuntimeError(
				"subagent.invalid_max_agent_duration",
				"Subagent maxAgentDurationMs must be a positive integer",
			);
		}
		if (
			!Number.isInteger(this.#workerNoProgressSteerMs) ||
			this.#workerNoProgressSteerMs < 1 ||
			!Number.isInteger(this.#workerNoProgressStopMs) ||
			this.#workerNoProgressStopMs <= this.#workerNoProgressSteerMs
		) {
			throw new SubagentRuntimeError(
				"subagent.invalid_no_progress_thresholds",
				"Worker no-progress thresholds must be positive integers and stop must be greater than steer",
			);
		}
		if (!Number.isInteger(this.#controlledVerificationTimeoutMs) || this.#controlledVerificationTimeoutMs < 1) {
			throw new SubagentRuntimeError(
				"subagent.invalid_verification_timeout",
				"Controlled verification timeout must be a positive integer",
			);
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
		const liveAgents = this.registry
			.list(workflowId)
			.filter(({ status, sessionReleasedAt }) => LIVE_AGENT_STATUSES.has(status) && !sessionReleasedAt);
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
		if (this.#executionWatchdog) {
			input = {
				...input,
				workflowDeadlineAtMs: undefined,
				parentBudget: watchdogBudget(input.parentBudget),
				workflowBudget: watchdogBudget(input.workflowBudget),
				taskBudget: watchdogBudget(input.taskBudget),
				profile: { ...input.profile, defaultBudget: watchdogBudget(input.profile.defaultBudget) },
			};
		}
		await this.#resourceRecovery;
		const profileViolations = validateAgentProfile(input.profile);
		if (profileViolations.length > 0) {
			throw new SubagentRuntimeError(
				"subagent.invalid_profile",
				profileViolations.map(({ message }) => message).join("; "),
			);
		}
		const liveAgents = this.registry
			.list(input.workflowId)
			.filter(({ status, sessionReleasedAt }) => LIVE_AGENT_STATUSES.has(status) && !sessionReleasedAt);
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
		const workflowUsage = sumResourceUsage(this.registry.list(input.workflowId).map(({ usage }) => usage));
		assertBudgetAvailable(workflowBudget, workflowUsage, {
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
		const inheritedBudget = inheritBudgetLimits(
			parentBudget,
			workflowBudget,
			input.taskBudget,
			input.profile.defaultBudget,
		);
		const remainingWorkflowDurationMs =
			input.workflowDeadlineAtMs === undefined ? undefined : Math.floor(input.workflowDeadlineAtMs - this.#now());
		if (remainingWorkflowDurationMs !== undefined && remainingWorkflowDurationMs < 1) {
			throw new RuntimePolicyError(
				"runtime_policy.workflow_duration_exhausted",
				`Workflow ${input.workflowId} duration budget is exhausted`,
			);
		}
		const durationLimits = [
			inheritedBudget.maxDurationMs,
			this.#executionWatchdog ? undefined : this.#maxAgentDurationMs,
			remainingWorkflowDurationMs,
		].filter((value): value is number => value !== undefined);
		const budget =
			durationLimits.length > 0
				? { ...inheritedBudget, maxDurationMs: Math.min(...durationLimits) }
				: inheritedBudget;
		const {
			backend,
			reason: backendReason,
			reasonCode: backendReasonCode,
		} = this.#selectBackend(
			input.backend === undefined && this.#defaultBackend ? { ...input, backend: this.#defaultBackend } : input,
			effectivePermissions,
			budget,
		);
		const creationReasonCode = this.#resolveCreationReasonCode(input);
		const sessionFactory = this.#sessionFactories.get(backend);
		if (!sessionFactory) {
			throw new SubagentRuntimeError("subagent.backend_unsupported", `Subagent backend ${backend} is unavailable`);
		}
		const toolNames = [...filterToolsByPermissions(input.profile.allowedTools, effectivePermissions)];
		if (!this.#workflowBudgets.has(input.workflowId)) {
			this.#workflowBudgets.set(input.workflowId, workflowBudget);
		}
		if (!existingWorkflowPermission) {
			this.#workflowPermissions.set(input.workflowId, workflowPermission);
		}
		const agentId = this.#createId("agent");
		const configuredModelName = resolveSubagentModelName(input.cwd, input.profile.model);
		const modelRoute = this.#modelGateway?.options.enabled
			? this.#modelGateway.route({
					role: input.profile.role,
					currentModelName: configuredModelName,
					explicitModel: input.profile.model !== undefined,
					riskLevel: input.riskLevel,
					escalationReason: input.modelEscalationReason,
					budget,
					usage: workflowUsage,
				})
			: undefined;
		const modelName = modelRoute?.model ? modelRoute.record.modelName : configuredModelName;
		const useWorkerWindows = modelRoute?.record.policy === "planner_executor" && input.profile.role === "worker";
		if (useWorkerWindows) {
			const contract = input.executionContract;
			if (
				!effectivePermissions.read ||
				!contract ||
				contract.workflowId !== input.workflowId ||
				contract.taskId !== input.taskId ||
				contract.attemptId !== input.attemptId
			) {
				throw new SubagentRuntimeError(
					"subagent.invalid_execution_contract",
					"Planner/Executor Worker requires read permission and a matching execution contract",
				);
			}
			formatWorkerExecutionContext(contract);
			// Session-memory tools do not grant repository writes, commands, or network access.
			for (const name of ["new_context", "history", "notes"]) {
				if (!toolNames.includes(name)) toolNames.push(name);
			}
		}
		const effectiveProfile =
			modelRoute && modelRoute.record.source === "configured" && modelRoute.record.modelName !== configuredModelName
				? { ...input.profile, model: modelRoute.record.modelName }
				: input.profile;
		const workspace = await this.#workspaceProvider.prepare({
			agentId,
			backend,
			write: effectivePermissions.write,
			input,
		});
		if (
			input.recoveryContext?.artifact &&
			input.recoveryContext.artifact.changedFiles.length > 0 &&
			this.#workspaceProvider.restoreArtifact
		) {
			try {
				await this.#workspaceProvider.restoreArtifact(workspace, input.recoveryContext.artifact);
			} catch (error) {
				await this.#workspaceProvider.release(workspace).catch(() => undefined);
				throw new SubagentRuntimeError(
					"workspace.recovery_restore_failed",
					`Failed to restore Artifact ${input.recoveryContext.artifact.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
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
			writeDeniedPaths: this.#writeDeniedPaths,
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
		this.#verificationEnvironments.set(agentId, Object.freeze({ ...sandboxHandle.environment }));
		this.#controlledVerifications.set(agentId, new Map());
		this.#controlledVerificationResults.set(agentId, new Map());
		const sandbox = await this.#sandboxBackend.verify(sandboxHandle);
		const timestamp = new Date(this.#now()).toISOString();
		this.registry.create({
			id: agentId,
			workflowId: input.workflowId,
			parentAgentId: input.parentAgentId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			profileName: input.profile.name,
			profile: structuredClone(effectiveProfile),
			profileSource: input.profileSource ?? "runtime",
			profileSourcePath: input.profileSourcePath,
			modelRoute: modelRoute?.record,
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
			responseTimeoutMs: this.#executionWatchdog?.inactivityMs,
			cwd: workspace.path,
			contextWindow: useWorkerWindows
				? { sessionDir: join(getAgentDir(), "sessions", "workers"), executionContract: input.executionContract }
				: undefined,
			profile: effectiveProfile,
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
				profile: effectiveProfile,
				workflowBudget,
				workflowPermission,
			}),
		);
		this.#pendingMutations.set(agentId, new Map());
		this.#pendingCommands.set(agentId, new Map());
		this.#commandDiagnostics.set(agentId, []);
		this.#verificationModificationCounts.set(agentId, new Map());
		this.#modifications.set(agentId, []);
		this.#incrementalUsage.set(agentId, zeroUsage());
		this.#transcripts.set(agentId, []);
		this.#unsubscribeEvents.set(
			agentId,
			session.onEvent((event) => this.#handleSessionEvent(agentId, event)),
		);
		try {
			const startTimeoutMs = this.#executionWatchdog?.inactivityMs ?? budget.maxDurationMs ?? 300_000;
			let startTimer: ReturnType<typeof setTimeout> | undefined;
			const startPromise = session.start().then(() => session.getSessionId());
			const startDeadline = new Promise<never>((_resolve, reject) => {
				startTimer = setTimeout(
					() =>
						reject(
							new SubagentRuntimeError(
								"subagent.start_timeout",
								`Agent ${agentId} startup exceeded ${startTimeoutMs}ms`,
							),
						),
					startTimeoutMs,
				);
			});
			const sessionId = await Promise.race([startPromise, startDeadline]).finally(() => clearTimeout(startTimer));
			this.registry.setSession(agentId, sessionId);
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
		if (!this.#originalPrompts.has(agentId)) {
			this.#originalPrompts.set(agentId, message);
		}
		this.#recordTranscript(agentId, "prompt", message);
		this.#pendingMutations.set(agentId, new Map());
		this.#modifications.set(agentId, []);
		this.#incrementalUsage.set(agentId, zeroUsage());
		this.registry.transition(agentId, "running");
		const startedAt = this.#now();
		this.#startNoProgressTimers(agentId);
		if (this.#executionWatchdog) {
			this.#watchdogs.set(
				agentId,
				new ExecutionWatchdog(this.#executionWatchdog, (evidence) => {
					void this.interrupt(agentId, `Execution watchdog: ${JSON.stringify(evidence)}`).catch(() => undefined);
				}),
			);
		}
		const timeoutMs = this.#executionWatchdog ? 0 : (agent.budget.maxDurationMs ?? 300_000);
		const idlePromise = session.waitForIdle(timeoutMs).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (
				/^timeout waiting for agent to become idle\b/i.test(message) ||
				/^in-process subagent timed out after \d+ms\b/i.test(message)
			) {
				throw new SubagentRuntimeError("subagent.duration_exceeded", `Agent ${agentId} exceeded ${timeoutMs}ms`);
			}
			throw error;
		});
		const promptPromise = session.prompt(message);
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const deadlinePromise = new Promise<void>((_resolve, reject) => {
			if (timeoutMs === 0) return;
			deadlineTimer = setTimeout(
				() =>
					reject(
						new SubagentRuntimeError("subagent.duration_exceeded", `Agent ${agentId} exceeded ${timeoutMs}ms`),
					),
				timeoutMs,
			);
		});
		const completionPromise = Promise.race([
			Promise.all([promptPromise, idlePromise]).then(() => undefined),
			deadlinePromise,
		]).finally(() => clearTimeout(deadlineTimer));
		const runPromise = this.#settleRun(agentId, completionPromise, startedAt, timeoutMs);
		this.#runPromises.set(agentId, runPromise);
		await Promise.race([promptPromise, idlePromise, deadlinePromise]).catch(async () => {
			await runPromise;
		});
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
		const failureReason = input.failureReason?.trim();
		const isProcessRecovery = !!recoveryReason;
		if (!isProcessRecovery && source.retryCount >= maximum) {
			throw new RuntimePolicyError(
				"runtime_policy.retry_exhausted",
				`Agent ${agentId} exhausted ${maximum} retries`,
			);
		}
		const existingRetry = this.registry
			.list(source.workflowId)
			.find((agent) =>
				isProcessRecovery ? agent.recoveryOfAgentId === source.id : agent.retryOfAgentId === source.id,
			);
		if (existingRetry) {
			throw new RuntimePolicyError(
				isProcessRecovery ? "runtime_policy.recovery_exists" : "runtime_policy.retry_exists",
				`Agent ${agentId} already has ${isProcessRecovery ? "recovery" : "retry"} Agent ${existingRetry.id}`,
			);
		}
		const spawnInput = this.#requireInput(agentId);
		const retryReason = recoveryReason ?? failureReason ?? source.lastError ?? "Previous Agent attempt failed";
		let recoveryContext = await this.#buildRecoveryContext(source, retryReason);
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
		const changedFiles = recoveryContext.artifact?.changedFiles.length ?? 0;
		const modelEscalationReason =
			input.modelEscalationReason ??
			(isProcessRecovery
				? undefined
				: changedFiles === 0
					? "no_progress"
					: source.retryCount > 0
						? "repeated_failure"
						: "retry");
		const retried = await this.spawn({
			...spawnInput,
			executionContract:
				input.executionContract ??
				(spawnInput.executionContract
					? { ...spawnInput.executionContract, attemptId: input.attemptId }
					: undefined),
			attemptId: input.attemptId,
			taskBudget: input.taskBudget ?? spawnInput.taskBudget,
			modelEscalationReason,
			retryCount: isProcessRecovery ? source.retryCount : source.retryCount + 1,
			retryOfAgentId: isProcessRecovery ? undefined : source.id,
			recoveryOfAgentId: isProcessRecovery ? source.id : undefined,
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
		this.#disposePromise ??= this.#disposeInternal();
		await this.#disposePromise;
	}

	async #disposeInternal(): Promise<void> {
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

	async #settleRun(
		agentId: AgentId,
		idlePromise: Promise<void>,
		startedAt: number,
		timeoutMs: number,
	): Promise<AgentRunResult> {
		const session = this.#requireSession(agentId);
		try {
			await idlePromise;
			const usage = await this.#getSessionUsage(agentId, session);
			let completedUsage = {
				...usage,
				durationMs: Math.max(0, this.#now() - startedAt),
			};
			this.registry.setUsage(agentId, completedUsage);
			if (this.#interrupting.has(agentId)) {
				const reason = this.#interruptReasons.get(agentId) ?? "Agent interrupted";
				this.#releaseWriter(agentId);
				this.registry.transition(agentId, "interrupted", reason);
				this.#recordPendingCommandDiagnostics(agentId, reason);
				await session.stop();
				const artifact = await this.#capturePartialWorkspace(agentId, reason);
				await this.#cleanupAgent(agentId);
				const interrupted: AgentRunResult = {
					agentId,
					status: "interrupted",
					usage: completedUsage,
					modifications: this.#modifications.get(agentId) ?? [],
					artifact,
					errorCode: reason.startsWith("No implementation progress")
						? "subagent.no_progress"
						: "subagent.interrupted",
					error: reason,
				};
				this.#lastResults.set(agentId, interrupted);
				return structuredClone(interrupted);
			}
			const agent = this.#requireAgent(agentId);
			this.#assertRunBudget(agentId, completedUsage);
			const text = await session.getLastAssistantText();
			if (!text) {
				throw new SubagentRuntimeError("subagent.output_missing", `Agent ${agentId} returned no output`);
			}
			this.#recordTranscript(agentId, "assistant", text);
			const identity = {
				id: this.#createId("handoff"),
				workflowId: agent.workflowId,
				taskId: agent.taskId,
				attemptId: agent.attemptId,
				agentId,
				createdAt: new Date(this.#now()).toISOString(),
			};
			const parsedHandoff = this.#redactor.redact(
				await this.#parseHandoffWithRepair(agentId, agent, session, text, identity, startedAt, timeoutMs),
			);
			if (this.#interrupting.has(agentId)) {
				throw new SubagentRuntimeError(
					"subagent.interrupted",
					this.#interruptReasons.get(agentId) ?? "Agent interrupted",
				);
			}
			completedUsage = {
				...(await this.#getSessionUsage(agentId, session)),
				durationMs: Math.max(0, this.#now() - startedAt),
			};
			this.registry.setUsage(agentId, completedUsage);
			this.#assertRunBudget(agentId, completedUsage);
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
			try {
				const verifiedCompletion = await this.#completeVerifiedWorkerAtDeadline(agentId, error, startedAt);
				if (verifiedCompletion) {
					return verifiedCompletion;
				}
			} catch (completionError) {
				return await this.#failRun(agentId, completionError, startedAt);
			}
			return await this.#failRun(agentId, error, startedAt);
		} finally {
			this.#watchdogs.get(agentId)?.dispose();
			this.#watchdogs.delete(agentId);
			this.#clearNoProgressTimers(agentId);
			this.#runPromises.delete(agentId);
			this.#interrupting.delete(agentId);
		}
	}

	#assertRunBudget(agentId: AgentId, usage: ResourceUsage): void {
		const agent = this.#requireAgent(agentId);
		const input = this.#requireInput(agentId);
		const workflowUsage = sumResourceUsage(this.registry.list(agent.workflowId).map(({ usage }) => usage));
		const overruns = [
			...evaluateBudget(agent.budget, usage).exceeded,
			...evaluateBudget(input.workflowBudget, workflowUsage).exceeded,
		];
		if (overruns.length === 0) {
			return;
		}
		const dimensions = [...new Set(overruns.map(({ dimension }) => dimension))];
		throw new RuntimePolicyError(
			"runtime_policy.budget_exhausted",
			`Agent ${agentId} exceeded ${dimensions.join(", ")}`,
			overruns,
		);
	}

	async #getSessionUsage(agentId: AgentId, session: SubagentSession): Promise<ResourceUsage> {
		const streamed = this.#incrementalUsage.get(agentId) ?? zeroUsage();
		const reported = await session.getUsage().catch(() => streamed);
		return {
			inputTokens: Math.max(reported.inputTokens, streamed.inputTokens),
			outputTokens: Math.max(reported.outputTokens, streamed.outputTokens),
			cacheReadTokens: Math.max(reported.cacheReadTokens, streamed.cacheReadTokens),
			cacheWriteTokens: Math.max(reported.cacheWriteTokens, streamed.cacheWriteTokens),
			cost: Math.max(reported.cost, streamed.cost),
			turns: Math.max(reported.turns, streamed.turns),
			durationMs: Math.max(reported.durationMs, streamed.durationMs),
		};
	}

	async #parseHandoffWithRepair(
		agentId: AgentId,
		agent: AgentInstance,
		session: SubagentSession,
		text: string,
		identity: Parameters<typeof parseHandoff>[1],
		startedAt: number,
		timeoutMs: number,
	): Promise<Handoff> {
		let candidate = text;
		let lastError: unknown;
		let omittedVerificationRepairAttempted = false;
		for (let correction = 0; correction < 2; correction++) {
			await this.#waitForControlledVerifications(agentId);
			let handoff: Handoff | undefined;
			try {
				handoff = parseHandoff(candidate, identity);
				lastError = undefined;
			} catch (error) {
				lastError = error;
			}
			const verificationProblem = handoff ? this.#requiredVerificationProblem(agentId) : undefined;
			if (handoff && !verificationProblem) {
				return handoff;
			}
			if (
				lastError !== undefined &&
				(!(lastError instanceof HandoffValidationError) ||
					(agent.profile?.role !== "worker" &&
						agent.profile?.role !== "planner_lite" &&
						agent.profile?.role !== "reviewer"))
			) {
				throw lastError;
			}
			const remainingMs = timeoutMs === 0 ? 0 : timeoutMs - Math.max(0, this.#now() - startedAt);
			if (timeoutMs !== 0 && remainingMs <= 0) {
				throw lastError ?? new SubagentRuntimeError("subagent.verification_failed", verificationProblem!.message);
			}
			const workerHasNoChanges = agent.profile?.role === "worker" && !this.#hasImplementationProgress(agentId);
			if (omittedVerificationRepairAttempted && verificationProblem) {
				throw new SubagentRuntimeError("subagent.verification_failed", verificationProblem.message);
			}
			const omittedVerification =
				verificationProblem?.kind === "not_run" && !workerHasNoChanges ? verificationProblem : undefined;
			if (omittedVerification) {
				omittedVerificationRepairAttempted = true;
			}
			const repairPrompt = workerHasNoChanges
				? [
						"No implementation change was detected. The response repeated planning instead of executing the assigned Task.",
						"Stay in this same Worker Session. Use the edit or write tool now, run the required verification commands, repair any failure, and return the structured Handoff only after implementation. Do not output another plan.",
					].join("\n")
				: omittedVerification
					? [
							`Required verification command was not run: ${omittedVerification.command}`,
							"Stay in this same Worker Session. The implementation patch already exists. Do not modify code or continue investigating before verification.",
							`Run this exact command now with the bash tool: ${omittedVerification.command}`,
							"Only if this command fails may you inspect its output and repair the code; rerun the same command after each repair. Return the complete structured Handoff only after it passes. A textual claim that it passed is not verification evidence.",
						].join("\n")
					: verificationProblem
						? [
								`Required verification is incomplete: ${verificationProblem.message}`,
								"Stay in this same Worker Session. Inspect the current implementation and command output, fix the code, rerun every required verification command, and only then return the structured Handoff. Do not create or restate a plan.",
							].join("\n")
						: [
								STRUCTURED_HANDOFF_RETRY_INSTRUCTION,
								`Format validation failed: ${(lastError as HandoffValidationError).message}`,
								"Return the corrected Handoff now using the existing Task result; do not redo the implementation.",
							].join("\n");
			this.#lastPrompts.set(agentId, repairPrompt);
			this.#recordTranscript(agentId, "prompt", repairPrompt);
			const repairIdle = session.waitForIdle(remainingMs);
			await Promise.all([session.prompt(repairPrompt), repairIdle]);
			const repairedText = await session.getLastAssistantText();
			if (!repairedText) {
				throw new SubagentRuntimeError("subagent.output_missing", `Agent ${agentId} returned no repaired Handoff`);
			}
			this.#recordTranscript(agentId, "assistant", repairedText);
			candidate = repairedText;
		}
		const handoff = parseHandoff(candidate, identity);
		await this.#waitForControlledVerifications(agentId);
		const verificationProblem = this.#requiredVerificationProblem(agentId);
		if (verificationProblem) {
			throw new SubagentRuntimeError("subagent.verification_failed", verificationProblem.message);
		}
		return handoff;
	}

	#requiredVerificationProblem(agentId: AgentId): RequiredVerificationProblem | undefined {
		const commands = this.#requireInput(agentId).verificationCommands ?? [];
		const results = this.#controlledVerificationResults.get(agentId);
		const modificationCount = this.#modifications.get(agentId)?.length ?? 0;
		for (const command of commands) {
			const normalized = command.trim();
			const latest = results?.get(normalized)?.diagnostic;
			if (!latest) {
				return {
					kind: "not_run",
					command: normalized,
					message: `required command was not run: ${normalized}`,
				};
			}
			if (latest.status !== "succeeded") {
				return {
					kind: "failed",
					command: normalized,
					message: `required command failed: ${normalized}${latest.output ? `\n${latest.output}` : ""}`,
				};
			}
			const verifiedAtModificationCount = this.#verificationModificationCounts.get(agentId)?.get(latest.toolCallId);
			if (verifiedAtModificationCount === undefined || verifiedAtModificationCount < modificationCount) {
				return {
					kind: "stale",
					command: normalized,
					message: `implementation changed after required command passed: ${normalized}`,
				};
			}
		}
		return undefined;
	}

	#startControlledVerification(agentId: AgentId, command: string, triggeringToolCallId: string): void {
		const agent = this.#requireAgent(agentId);
		const environment = this.#verificationEnvironments.get(agentId);
		const running = this.#controlledVerifications.get(agentId);
		if (!agent.workspace || !environment || !running) {
			return;
		}
		const cwd = agent.workspace.path;
		const verificationId = `controlled:${triggeringToolCallId}`;
		const sequence = ++this.#controlledVerificationSequence;
		const modificationCount = this.#modifications.get(agentId)?.length ?? 0;
		const promise = Promise.resolve()
			.then(() =>
				this.#verificationRunner({
					command,
					cwd,
					environment,
					timeoutMs: this.#controlledVerificationTimeoutMs,
				}),
			)
			.then((result) => {
				const changedDuringVerification = (this.#modifications.get(agentId)?.length ?? 0) !== modificationCount;
				const succeeded = result.exitCode === 0 && !result.timedOut && !changedDuringVerification;
				const failureReason = result.timedOut
					? `Controlled verification timed out after ${this.#controlledVerificationTimeoutMs}ms`
					: changedDuringVerification
						? "Implementation changed while controlled verification was running"
						: result.exitCode === undefined
							? "Controlled verification ended without an exit code"
							: `Controlled verification exited with code ${result.exitCode}`;
				const diagnostic: AgentCommandDiagnostic = {
					toolCallId: verificationId,
					command,
					status: succeeded ? "succeeded" : "failed",
					output: [result.output.trim(), ...(succeeded ? [] : [failureReason])].filter(Boolean).join("\n"),
					source: "controlled",
				};
				const diagnostics = this.#commandDiagnostics.get(agentId);
				diagnostics?.push(diagnostic);
				const results = this.#controlledVerificationResults.get(agentId);
				const existing = results?.get(command.trim());
				if (!existing || sequence >= existing.sequence) {
					results?.set(command.trim(), { sequence, diagnostic });
				}
				this.#verificationModificationCounts.get(agentId)?.set(verificationId, modificationCount);
				if (diagnostics && diagnostics.length > 6) {
					diagnostics.splice(0, diagnostics.length - 6);
				}
				this.#recordTranscript(agentId, "activity", `${COMMAND_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`);
				if (!succeeded) {
					void this.send(
						agentId,
						`Required verification failed under the parent runtime: ${command}. Stay in this same Worker Session, use the controlled failure output to repair the implementation, rerun the exact command, and do not return a Handoff until it passes.\n${diagnostic.output ?? ""}`,
					).catch(() => undefined);
					return;
				}
				if (
					agent.profile?.role === "worker" &&
					this.#hasImplementationProgress(agentId) &&
					this.#requiredVerificationsPassed(agentId) &&
					!this.#verificationCompleteSteered.has(agentId)
				) {
					this.#verificationCompleteSteered.add(agentId);
					void this.send(
						agentId,
						"All required verification commands passed under the parent runtime for the current implementation. Stop additional exploration and optional test runs. Return the complete structured Handoff now.",
					).catch(() => undefined);
				}
			})
			.catch((error) => {
				const diagnostic: AgentCommandDiagnostic = {
					toolCallId: verificationId,
					command,
					status: "failed",
					output: `Controlled verification runner failed: ${error instanceof Error ? error.message : String(error)}`,
					source: "controlled",
				};
				this.#commandDiagnostics.get(agentId)?.push(diagnostic);
				const results = this.#controlledVerificationResults.get(agentId);
				const existing = results?.get(command.trim());
				if (!existing || sequence >= existing.sequence) {
					results?.set(command.trim(), { sequence, diagnostic });
				}
				this.#verificationModificationCounts.get(agentId)?.set(verificationId, modificationCount);
				this.#recordTranscript(agentId, "activity", `${COMMAND_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`);
			});
		running.set(verificationId, { promise });
		void promise.finally(() => running.delete(verificationId));
	}

	async #waitForControlledVerifications(agentId: AgentId): Promise<void> {
		const running = this.#controlledVerifications.get(agentId);
		while (running && running.size > 0) {
			await Promise.all([...running.values()].map(({ promise }) => promise));
		}
	}

	#requiredVerificationsPassed(agentId: AgentId): boolean {
		const commands = this.#requireInput(agentId).verificationCommands ?? [];
		return commands.length > 0 && this.#requiredVerificationProblem(agentId) === undefined;
	}

	#hasImplementationProgress(agentId: AgentId): boolean {
		const agent = this.#requireAgent(agentId);
		return (
			(this.#modifications.get(agentId)?.length ?? 0) > 0 ||
			(agent.recoveryContext?.artifact?.changedFiles.length ?? 0) > 0
		);
	}

	async #completeVerifiedWorkerAtDeadline(
		agentId: AgentId,
		error: unknown,
		startedAt: number,
	): Promise<AgentRunResult | undefined> {
		if (!(error instanceof SubagentRuntimeError) || error.code !== "subagent.duration_exceeded") {
			return undefined;
		}
		const agent = this.#requireAgent(agentId);
		await this.#waitForControlledVerifications(agentId);
		if (
			agent.profile?.role !== "worker" ||
			!this.#hasImplementationProgress(agentId) ||
			!this.#requiredVerificationsPassed(agentId)
		) {
			return undefined;
		}
		const session = this.#requireSession(agentId);
		this.#recordPendingCommandDiagnostics(agentId, "Session deadline reached after required verification passed");
		await session.stop().catch(() => undefined);
		const completedUsage = {
			...(await this.#getSessionUsage(agentId, session)),
			durationMs: Math.max(0, this.#now() - startedAt),
		};
		this.registry.setUsage(agentId, completedUsage);
		const changedFiles = [
			...new Set([
				...(agent.recoveryContext?.artifact?.changedFiles ?? []),
				...(this.#modifications.get(agentId) ?? []).map(({ path }) => path),
			]),
		];
		const commands = this.#requireInput(agentId).verificationCommands ?? [];
		const parsedHandoff = this.#redactor.redact<Handoff>({
			id: this.#createId("handoff"),
			workflowId: agent.workflowId,
			taskId: agent.taskId,
			attemptId: agent.attemptId,
			agentId,
			conclusion: "Implementation completed and required verification passed before the Worker Session deadline.",
			evidence: changedFiles.map((path) => ({
				path,
				note: "Changed before required verification passed",
			})),
			architectureFindings: [],
			changedFiles,
			verificationSummary: commands.map((command) => `${command}: passed before Session deadline`),
			risks: [
				"The Worker Session reached its deadline before returning a structured Handoff; Reviewer and external verification must validate the retained Artifact.",
			],
			unfinishedItems: [],
			createdAt: new Date(this.#now()).toISOString(),
		});
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
		this.#recordTranscript(
			agentId,
			"activity",
			"Runtime finalized the verified Worker result at its Session deadline",
		);
		this.registry.recordHandoff(agentId, handoff);
		this.#releaseWriter(agentId);
		if (this.#requireAgent(agentId).status === "waiting") {
			this.registry.transition(agentId, "running", "Agent resumed before verified deadline completion");
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
	}

	#startNoProgressTimers(agentId: AgentId): void {
		this.#clearNoProgressTimers(agentId);
		if (this.#executionWatchdog) return;
		const agent = this.#requireAgent(agentId);
		if (agent.profile?.role !== "worker" || !agent.effectivePermissions.write) {
			return;
		}
		const retryMultiplier = agent.retryCount > 0 ? 2 : 1;
		const steerMs = this.#workerNoProgressSteerMs * retryMultiplier;
		const stopMs = this.#workerNoProgressStopMs * retryMultiplier;
		const steerTimer = setTimeout(() => {
			if (this.#hasImplementationProgress(agentId) || this.#noProgressSteered.has(agentId)) return;
			this.#noProgressSteered.add(agentId);
			void this.send(
				agentId,
				"Stop planning and broad exploration. No code change has been detected. Implement the assigned file changes now, then run the required verification and repair failures in this same Session.",
			).catch(() => undefined);
		}, steerMs);
		const stopTimer = setTimeout(() => {
			if (this.#hasImplementationProgress(agentId) || this.#noProgressStopped.has(agentId)) return;
			this.#noProgressStopped.add(agentId);
			void this.interrupt(
				agentId,
				`No implementation progress after ${stopMs}ms; escalate to the strong tier`,
			).catch(() => undefined);
		}, stopMs);
		this.#noProgressTimers.set(agentId, [steerTimer, stopTimer]);
	}

	#clearNoProgressTimers(agentId: AgentId): void {
		for (const timer of this.#noProgressTimers.get(agentId) ?? []) clearTimeout(timer);
		this.#noProgressTimers.delete(agentId);
	}

	async #failRun(agentId: AgentId, error: unknown, startedAt: number): Promise<AgentRunResult> {
		const fallbackMessage = this.#redactor.redactText(error instanceof Error ? error.message : String(error));
		const message = this.#interrupting.has(agentId)
			? (this.#interruptReasons.get(agentId) ?? fallbackMessage)
			: fallbackMessage;
		const session = this.#sessions.get(agentId);
		this.#recordPendingCommandDiagnostics(agentId, message);
		if (session) {
			const lastAssistantText = await session.getLastAssistantText().catch(() => null);
			if (lastAssistantText) {
				this.#recordTranscript(agentId, "assistant", lastAssistantText);
			}
		}
		const usage = session
			? await this.#getSessionUsage(agentId, session)
			: (this.#incrementalUsage.get(agentId) ?? zeroUsage());
		const completedUsage = {
			...usage,
			durationMs: Math.max(0, this.#now() - startedAt),
		};
		this.registry.setUsage(agentId, completedUsage);
		const agent = this.#requireAgent(agentId);
		if (agent.status === "stopping") {
			this.registry.transition(agentId, "interrupted", message);
		} else if (agent.status !== "failed") {
			this.registry.fail(agentId, message);
		}
		this.#releaseWriter(agentId);
		await session?.stop().catch(() => undefined);
		const artifact = await this.#capturePartialWorkspace(agentId, message);
		await this.#cleanupAgent(agentId);
		const result: AgentRunResult = {
			agentId,
			status: this.#interrupting.has(agentId) ? "interrupted" : "failed",
			usage: completedUsage,
			modifications: [...(this.#modifications.get(agentId) ?? [])],
			artifact,
			errorCode: message.startsWith("No implementation progress")
				? "subagent.no_progress"
				: error instanceof SubagentRuntimeError
					? error.code
					: this.#interrupting.has(agentId)
						? "subagent.interrupted"
						: "subagent.failed",
			error: message,
		};
		this.#lastResults.set(agentId, result);
		return structuredClone(result);
	}

	#recordPendingCommandDiagnostics(agentId: AgentId, failure: string): void {
		const pendingCommands = this.#pendingCommands.get(agentId);
		const diagnostics = this.#commandDiagnostics.get(agentId);
		if (!pendingCommands || !diagnostics) {
			return;
		}
		for (const [toolCallId, pending] of pendingCommands) {
			const diagnostic: AgentCommandDiagnostic = {
				toolCallId,
				command: pending.command,
				status: "failed",
				output: `Agent ended before the command completed: ${failure}`,
				source: "agent",
			};
			diagnostics.push(diagnostic);
			this.#recordTranscript(agentId, "activity", `${COMMAND_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`);
		}
		pendingCommands.clear();
		if (diagnostics.length > 6) {
			diagnostics.splice(0, diagnostics.length - 6);
		}
	}

	#handleSessionEvent(agentId: AgentId, value: unknown): void {
		this.#watchdogs.get(agentId)?.observe(value);
		if (typeof value !== "object" || value === null) {
			return;
		}
		const event = value as RuntimeEventShape;
		const type = typeof event.type === "string" ? event.type : "";
		if (type === "tool_execution_start") {
			if (event.toolName === "bash" && typeof event.toolCallId === "string") {
				const command = commandText(event.args);
				if (command) {
					this.#pendingCommands.get(agentId)?.set(event.toolCallId, { command });
				}
			}
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
			const pendingCommand = this.#pendingCommands.get(agentId)?.get(event.toolCallId);
			this.#pendingCommands.get(agentId)?.delete(event.toolCallId);
			if (pendingCommand) {
				const diagnostics = this.#commandDiagnostics.get(agentId);
				const diagnostic: AgentCommandDiagnostic = {
					toolCallId: event.toolCallId,
					command: pendingCommand.command,
					status: event.isError === true ? "failed" : "succeeded",
					output: diagnosticOutput(event.result),
					source: "agent",
				};
				diagnostics?.push(diagnostic);
				if (diagnostics && diagnostics.length > 6) {
					diagnostics.splice(0, diagnostics.length - 6);
				}
				this.#recordTranscript(agentId, "activity", `${COMMAND_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`);
				const requiredCommands = this.#requireInput(agentId).verificationCommands ?? [];
				const requiredCommand = requiredCommands.find((command) => command.trim() === diagnostic.command.trim());
				if (requiredCommand) {
					this.#startControlledVerification(agentId, requiredCommand, event.toolCallId);
				}
			}
			const pending = this.#pendingMutations.get(agentId)?.get(event.toolCallId);
			this.#pendingMutations.get(agentId)?.delete(event.toolCallId);
			if (pending && event.isError !== true) {
				this.#modifications.get(agentId)?.push({
					path: pending.path,
					operation: pending.operation,
					toolCallId: event.toolCallId,
				});
				this.#verificationCompleteSteered.delete(agentId);
				this.#clearNoProgressTimers(agentId);
			}
			const agent = this.#requireAgent(agentId);
			if (
				agent.profile?.role === "worker" &&
				this.#hasImplementationProgress(agentId) &&
				this.#requiredVerificationsPassed(agentId) &&
				!this.#verificationCompleteSteered.has(agentId)
			) {
				this.#verificationCompleteSteered.add(agentId);
				void this.send(
					agentId,
					"All required verification commands passed for the current implementation. Stop additional exploration and optional test runs. Return the complete structured Handoff now.",
				).catch(() => undefined);
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
				return;
			}
			if (
				!this.#executionWatchdog &&
				agent.profile?.role === "reviewer" &&
				usage.turns >= REVIEWER_FINALIZE_TURNS &&
				!this.#reviewerFinalizeSteered.has(agentId)
			) {
				this.#reviewerFinalizeSteered.add(agentId);
				void this.send(
					agentId,
					"Stop reading and searching. Decide from the evidence already collected and return the complete structured Handoff now. Start one verificationSummary item with exactly review:passed or review:failed. Do not call another tool.",
				).catch(() => undefined);
			}
			const noImplementationProgress =
				!this.#executionWatchdog &&
				agent.profile?.role === "worker" &&
				agent.effectivePermissions.write &&
				!this.#hasImplementationProgress(agentId);
			const steerTurns = agent.retryCount > 0 ? WORKER_NO_PROGRESS_STEER_TURNS * 2 : WORKER_NO_PROGRESS_STEER_TURNS;
			const stopTurns = agent.retryCount > 0 ? WORKER_NO_PROGRESS_STOP_TURNS * 2 : WORKER_NO_PROGRESS_STOP_TURNS;
			if (noImplementationProgress && usage.turns >= stopTurns && !this.#noProgressStopped.has(agentId)) {
				this.#noProgressStopped.add(agentId);
				void this.interrupt(
					agentId,
					`No implementation progress after ${usage.turns} Worker turns; escalate to the strong tier`,
				).catch(() => undefined);
				return;
			}
			if (noImplementationProgress && usage.turns >= steerTurns && !this.#noProgressSteered.has(agentId)) {
				this.#noProgressSteered.add(agentId);
				void this.send(
					agentId,
					"Stop planning and broad exploration. No code change has been detected. Implement the assigned file changes now, then run the required verification and repair failures in this same Session.",
				).catch(() => undefined);
			}
			return;
		}
		if (type === "auto_retry_start") {
			this.registry.progress(agentId, "Model retry started");
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
		this.#watchdogs.get(agentId)?.dispose();
		this.#watchdogs.delete(agentId);
		this.#clearNoProgressTimers(agentId);
		this.#unsubscribeEvents.get(agentId)?.();
		this.#unsubscribeEvents.delete(agentId);
		this.#unregisterRuntime.get(agentId)?.();
		this.#unregisterRuntime.delete(agentId);
		this.#sessions.delete(agentId);
		this.#noProgressSteered.delete(agentId);
		this.#noProgressStopped.delete(agentId);
		this.#verificationCompleteSteered.delete(agentId);
		this.#verificationModificationCounts.delete(agentId);
		this.#verificationEnvironments.delete(agentId);
		this.#reviewerFinalizeSteered.delete(agentId);
		this.#controlledVerifications.delete(agentId);
		this.#controlledVerificationResults.delete(agentId);
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
	): {
		backend: AgentBackend;
		reason: string;
		reasonCode: BackendSelectionReasonCode;
	} {
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
		const originalPrompt =
			this.#originalPrompts.get(source.id) ?? transcript.find(({ type }) => type === "prompt")?.text;
		const lastPrompt = [...transcript].reverse().find(({ type }) => type === "prompt")?.text;
		const lastAssistantText = [...transcript].reverse().find(({ type }) => type === "assistant")?.text;
		const persistedCommandDiagnostics = transcript.flatMap(({ type, text }) => {
			if (type !== "activity") {
				return [];
			}
			const diagnostic = parseCommandDiagnostic(text);
			return diagnostic ? [diagnostic] : [];
		});
		const commandDiagnostics = this.#commandDiagnostics.get(source.id) ?? persistedCommandDiagnostics.slice(-6);
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
			originalPrompt,
			lastPrompt,
			lastAssistantText,
			commandDiagnostics,
			handoff: source.handoffId ? this.registry.getHandoff(source.handoffId) : undefined,
			artifact,
			artifactPatch,
			workspace,
		});
	}

	async #capturePartialWorkspace(agentId: AgentId, reason: string): Promise<WorkspaceArtifact | undefined> {
		const agent = this.#requireAgent(agentId);
		if (agent.artifact || !agent.workspace || !this.#workspaceProvider.createArtifact) {
			return agent.artifact;
		}
		try {
			const created = await this.#workspaceProvider.createArtifact(
				agent.workspace,
				this.#modifications.get(agentId) ?? [],
			);
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
			return artifact;
		} catch (error) {
			this.registry.progress(
				agentId,
				`Failed to preserve partial Workspace after ${reason}: ${this.#redactor.redactText(error instanceof Error ? error.message : String(error))}`,
			);
			return undefined;
		}
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
				const integrated = await this.#multiWriterIntegration.integrate({
					artifact,
					handoff,
				});
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
