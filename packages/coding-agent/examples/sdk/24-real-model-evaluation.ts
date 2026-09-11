/**
 * Real-model CLI Agent Evaluation
 *
 * Uses the active Provider/Model and a versioned fixture Task Set. Each
 * Strategy receives a fresh Git repository with the same content, Prompt,
 * verification commands, and external budget.
 *
 * Examples:
 *   npm run eval:cli-agent:model -- --verify-task-set
 *   npm run eval:cli-agent:model -- --task-set path/to/task-set.json --verify-task-set
 *   npm run eval:cli-agent:model -- --strategies single_agent,automatic
 *   npm run eval:cli-agent:model -- --output .artifacts/r16-run
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertEvaluationEscalationRouting,
	assessEvaluationProtocol,
	buildEvaluationReport,
	classifyEvaluationFailure,
	countReachedModelRoutes,
	createAgentSession,
	createEvaluationBashToolDefinition,
	type DecisionReasonCode,
	digestProtectedPaths,
	EVALUATION_ESCALATION_POLICY,
	EVALUATION_PROTOCOL_VERSION,
	EVALUATION_SCHEMA_VERSION,
	EVALUATION_SHELL_POLICY_VERSION,
	EVALUATION_SHELL_TIMEOUT_SECONDS,
	EVALUATION_STRATEGIES,
	type EvaluationCheckpoint,
	type EvaluationEscalationPolicy,
	type EvaluationModelIdentity,
	type EvaluationReport,
	type EvaluationRunRecord,
	type EvaluationStrategy,
	EXECUTION_PROTOCOL_VERSION,
	evaluateRegressionGate,
	evaluationRunTimeoutMs,
	evaluationSoftLimitTrigger,
	formatEvaluationReportMarkdown,
	InProcessSubagentSessionFactory,
	isEvaluationInfrastructureFailure,
	MODE_ADVISOR_PROMPT_VERSION,
	ModelGateway,
	type ModelRouteRecord,
	type ModelRouteRole,
	type ModelRoutingOptions,
	ModelRuntime,
	parseEvaluationCheckpoint,
	parseEvaluationTaskSet,
	RpcSubagentSessionFactory,
	remainingEvaluationDurationMs,
	SessionManager,
	SessionSubagentPersistence,
	SettingsManager,
	SubagentRuntime,
	summarizeEvaluationRepairs,
	sumResourceUsage,
	type WorkflowExecutionProtocol,
	type WorkflowView,
} from "@earendil-works/pi-coding-agent";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASK_SET_PATH = resolve(SCRIPT_DIR, "../../evals/r16/task-set.json");

const EVALUATION_EXECUTION_INSTRUCTION =
	"Follow the configured execution policy. If it selects Direct, use only the main Agent and do not delegate. If it selects Plan, follow the generated Workflow. Diagnose, implement, and run the required verification without modifying protected paths. Restrict filesystem searches to the working repository, use PI_EVALUATION_NODE_MODULES for injected dependencies, and prioritize required verification after making the change.";

const STRATEGY_PROTOCOLS: Readonly<Record<EvaluationStrategy, WorkflowExecutionProtocol>> = {
	single_agent: {
		version: EXECUTION_PROTOCOL_VERSION,
		name: "single-agent",
		requirements: [],
	},
	main_explorer: {
		version: EXECUTION_PROTOCOL_VERSION,
		name: "main-explorer",
		requirements: [
			{
				id: "explorer-before-main",
				stage: "before_main",
				role: "explorer",
				required: true,
				minRuns: 1,
				maxRuns: 2,
				failurePolicy: "retry_once",
			},
		],
	},
	main_reviewer: {
		version: EXECUTION_PROTOCOL_VERSION,
		name: "main-reviewer",
		requirements: [
			{
				id: "planner-lite-before-main",
				stage: "before_main",
				role: "planner",
				required: true,
				minRuns: 1,
				maxRuns: 2,
				failurePolicy: "retry_once",
			},
			{
				id: "reviewer-before-delivery",
				stage: "before_delivery",
				role: "reviewer",
				required: true,
				minRuns: 1,
				maxRuns: 2,
				failurePolicy: "retry_once",
			},
		],
	},
	planner_worker_reviewer: {
		version: EXECUTION_PROTOCOL_VERSION,
		name: "planner-worker-reviewer",
		requirements: [
			{
				id: "worker-implementation",
				stage: "implementation",
				role: "worker",
				required: true,
				minRuns: 1,
				maxRuns: 2,
				failurePolicy: "retry_once",
			},
			{
				id: "reviewer-before-delivery",
				stage: "before_delivery",
				role: "reviewer",
				required: true,
				minRuns: 1,
				maxRuns: 2,
				failurePolicy: "retry_once",
			},
		],
	},
	automatic: {
		version: EXECUTION_PROTOCOL_VERSION,
		name: "automatic",
		requirements: [],
	},
};

interface EvaluationCliOptions {
	readonly strategies: readonly EvaluationStrategy[];
	readonly taskIds?: readonly string[];
	readonly taskSetPath: string;
	readonly provider?: string;
	readonly model?: string;
	readonly outputDirectory: string;
	readonly baselineReportPath?: string;
	readonly verifyTaskSet: boolean;
	readonly repetitions: number;
	readonly keepFailedWorkspaces: boolean;
	readonly keepWorkspaces: boolean;
	readonly resume: boolean;
}

interface CommandResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

function parseOptions(args: readonly string[]): EvaluationCliOptions {
	let strategies: readonly EvaluationStrategy[] = EVALUATION_STRATEGIES;
	let outputDirectory = resolve(".artifacts", "r16-evaluation");
	let baselineReportPath: string | undefined;
	let taskIds: readonly string[] | undefined;
	let taskSetPath = DEFAULT_TASK_SET_PATH;
	let provider: string | undefined;
	let model: string | undefined;
	let verifyTaskSet = false;
	let repetitions = 1;
	let keepFailedWorkspaces = false;
	let keepWorkspaces = false;
	let resume = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--strategies") {
			const value = args[++index];
			if (!value) throw new Error("--strategies requires a comma-separated value");
			const requested = value.split(",").map((entry) => entry.trim());
			if (requested.some((entry) => !EVALUATION_STRATEGIES.includes(entry as EvaluationStrategy))) {
				throw new Error(`Unsupported Strategy: ${value}`);
			}
			strategies = requested as readonly EvaluationStrategy[];
			continue;
		}
		if (argument === "--output") {
			const value = args[++index];
			if (!value) throw new Error("--output requires a directory");
			outputDirectory = resolve(value);
			continue;
		}
		if (argument === "--tasks") {
			const value = args[++index];
			if (!value) throw new Error("--tasks requires a comma-separated value");
			taskIds = value.split(",").map((entry) => entry.trim());
			continue;
		}
		if (argument === "--task-set") {
			const value = args[++index];
			if (!value) throw new Error("--task-set requires a path");
			taskSetPath = resolve(value);
			continue;
		}
		if (argument === "--provider") {
			provider = args[++index]?.trim();
			if (!provider) throw new Error("--provider requires a value");
			continue;
		}
		if (argument === "--model") {
			model = args[++index]?.trim();
			if (!model) throw new Error("--model requires a value");
			continue;
		}
		if (argument === "--baseline") {
			const value = args[++index];
			if (!value) throw new Error("--baseline requires a report path");
			baselineReportPath = resolve(value);
			continue;
		}
		if (argument === "--repetitions") {
			const value = args[++index];
			repetitions = Number(value);
			if (!Number.isInteger(repetitions) || repetitions < 1) {
				throw new Error("--repetitions must be a positive integer");
			}
			continue;
		}
		if (argument === "--verify-task-set") {
			verifyTaskSet = true;
			continue;
		}
		if (argument === "--keep-failed-workspaces") {
			keepFailedWorkspaces = true;
			continue;
		}
		if (argument === "--keep-workspaces") {
			keepWorkspaces = true;
			continue;
		}
		if (argument === "--resume") {
			resume = true;
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	return {
		strategies,
		taskIds,
		taskSetPath,
		provider,
		model,
		outputDirectory,
		baselineReportPath,
		verifyTaskSet,
		repetitions,
		keepFailedWorkspaces,
		keepWorkspaces,
		resume,
	};
}

function fixtureFiles(root: string, directory = root): readonly string[] {
	const files: string[] = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			files.push(...fixtureFiles(root, path));
		} else {
			files.push(path);
		}
	}
	return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function fixtureDigest(root: string): string {
	const hash = createHash("sha256");
	for (const path of fixtureFiles(root)) {
		hash.update(relative(root, path).replaceAll("\\", "/"));
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

function fileDigest(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function digestJson(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function evaluationRunConfigurationDigest(
	taskSet: ReturnType<typeof parseEvaluationTaskSet>,
	task: ReturnType<typeof parseEvaluationTaskSet>["tasks"][number],
	model: EvaluationModelIdentity,
	escalationPolicy: EvaluationEscalationPolicy,
): string {
	return digestJson({
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		evaluationProtocolVersion: EVALUATION_PROTOCOL_VERSION,
		taskSet: { id: taskSet.id, version: taskSet.version },
		task: {
			id: task.id,
			repositoryBaseline: task.repositoryBaseline,
			promptDigest: digestJson(task.prompt),
			promptVersion: task.promptVersion,
			verificationCommands: task.verificationCommands,
			protectedPaths: task.protectedPaths,
			successCriteria: task.successCriteria,
			expectedReviewerFindings: task.expectedReviewerFindings,
			budget: task.budget,
			difficulty: task.difficulty,
			expectedStrategy: task.expectedStrategy,
			expectedModelRoutes: task.expectedModelRoutes,
			source: task.source,
			localRuntime: task.localRuntime,
		},
		executionInstruction: EVALUATION_EXECUTION_INSTRUCTION,
		modeAdvisorPromptVersion: MODE_ADVISOR_PROMPT_VERSION,
		shellPolicy: {
			version: EVALUATION_SHELL_POLICY_VERSION,
			timeoutSeconds: EVALUATION_SHELL_TIMEOUT_SECONDS,
		},
		escalationPolicy,
		model,
	});
}

function actualModelNamesFromMessages(messages: readonly unknown[]): readonly string[] {
	const names = new Set<string>();
	for (const message of messages) {
		if (
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			message.role === "assistant" &&
			"provider" in message &&
			typeof message.provider === "string" &&
			"model" in message &&
			typeof message.model === "string"
		) {
			names.add(`${message.provider}/${message.model}`);
		}
	}
	return [...names];
}

async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
	return new Promise((resolveCommand) => {
		const child = spawn(command, { cwd, shell: true, windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			resolveCommand({ exitCode, stdout, stderr, timedOut });
		});
	});
}

function fixedVerificationCommand(command: string): string {
	if (command !== "node" && !command.startsWith("node ")) return command;
	return `"${process.execPath}"${command.slice(4)}`;
}

async function runVerificationCommands(
	task: ReturnType<typeof parseEvaluationTaskSet>["tasks"][number],
	workspace: string,
	timeoutMs = task.budget.maxDurationMs,
): Promise<readonly CommandResult[]> {
	return Promise.all(
		task.verificationCommands.map((command) => runCommand(fixedVerificationCommand(command), workspace, timeoutMs)),
	);
}

async function withTaskLocalRuntime<T>(
	task: ReturnType<typeof parseEvaluationTaskSet>["tasks"][number],
	taskSetDirectory: string,
	action: () => Promise<T>,
): Promise<T> {
	if (!task.localRuntime) return action();
	const executable = resolve(taskSetDirectory, task.localRuntime.executable);
	const nodeModules = resolve(taskSetDirectory, task.localRuntime.nodeModules);
	if (!existsSync(executable) || !existsSync(nodeModules)) {
		throw new Error(`Local runtime for ${task.id} is missing: executable=${executable}, nodeModules=${nodeModules}`);
	}
	const actualExecutableBaseline = fileDigest(executable);
	const actualNodeModulesBaseline = fixtureDigest(nodeModules);
	if (
		actualExecutableBaseline !== task.localRuntime.executableBaseline ||
		actualNodeModulesBaseline !== task.localRuntime.nodeModulesBaseline
	) {
		throw new Error(
			`Local runtime integrity failed for ${task.id}: executable=${actualExecutableBaseline}, nodeModules=${actualNodeModulesBaseline}`,
		);
	}
	const previousNode = process.env.PI_EVALUATION_NODE;
	const previousNodeModules = process.env.PI_EVALUATION_NODE_MODULES;
	process.env.PI_EVALUATION_NODE = executable;
	process.env.PI_EVALUATION_NODE_MODULES = nodeModules;
	try {
		return await action();
	} finally {
		if (previousNode === undefined) delete process.env.PI_EVALUATION_NODE;
		else process.env.PI_EVALUATION_NODE = previousNode;
		if (previousNodeModules === undefined) delete process.env.PI_EVALUATION_NODE_MODULES;
		else process.env.PI_EVALUATION_NODE_MODULES = previousNodeModules;
	}
}

function verificationInfrastructureFailed(results: readonly CommandResult[]): boolean {
	const combinedOutput = results
		.map(({ stdout, stderr }) => `${stdout}\n${stderr}`)
		.join("\n")
		.toLowerCase();
	return (
		results.some(({ exitCode, timedOut }) => exitCode === null && !timedOut) ||
		combinedOutput.includes("python 3 was not found") ||
		combinedOutput.includes("is not recognized as an internal or external command") ||
		combinedOutput.includes("node: not found")
	);
}

async function verifyDefectiveBaseline(
	task: ReturnType<typeof parseEvaluationTaskSet>["tasks"][number],
	taskSetDirectory: string,
): Promise<{ readonly valid: boolean; readonly summary: string }> {
	const runRoot = mkdtempSync(join(tmpdir(), `pi-eval-baseline-${task.id}-`));
	const workspace = join(runRoot, "repository");
	try {
		cpSync(resolve(taskSetDirectory, task.repositoryFixture), workspace, { recursive: true });
		const missingProtectedPaths = task.protectedPaths.filter((path) => !existsSync(resolve(workspace, path)));
		if (missingProtectedPaths.length > 0) {
			return { valid: false, summary: `protected paths are missing: ${missingProtectedPaths.join(", ")}` };
		}
		const results = await withTaskLocalRuntime(task, taskSetDirectory, () =>
			runVerificationCommands(task, workspace),
		);
		if (results.some(({ timedOut }) => timedOut) || verificationInfrastructureFailed(results)) {
			return { valid: false, summary: "verification infrastructure failed" };
		}
		if (results.every(({ exitCode }) => exitCode === 0)) {
			return { valid: false, summary: "baseline unexpectedly passes all verification commands" };
		}
		return { valid: true, summary: "baseline fails as expected" };
	} finally {
		rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}

async function initializeRepository(workspace: string): Promise<void> {
	for (const command of [
		"git init --quiet",
		'git config user.email "r16-evaluation@localhost"',
		'git config user.name "R16 Evaluation"',
		"git add --all",
		'git commit --quiet -m "evaluation baseline"',
	]) {
		const result = await runCommand(command, workspace, 30_000);
		if (result.exitCode !== 0) {
			throw new Error(`Repository initialization failed: ${command}\n${result.stderr}`);
		}
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function zeroUsage() {
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

function usageFromMessages(messages: readonly unknown[]) {
	const turns = messages.flatMap((message) => {
		if (
			typeof message !== "object" ||
			message === null ||
			!("role" in message) ||
			message.role !== "assistant" ||
			!("usage" in message) ||
			typeof message.usage !== "object" ||
			message.usage === null
		) {
			return [];
		}
		const usage = message.usage;
		const inputTokens = "input" in usage && typeof usage.input === "number" ? usage.input : 0;
		const outputTokens = "output" in usage && typeof usage.output === "number" ? usage.output : 0;
		const cacheReadTokens = "cacheRead" in usage && typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		const cacheWriteTokens = "cacheWrite" in usage && typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
		const cost =
			"cost" in usage &&
			typeof usage.cost === "object" &&
			usage.cost !== null &&
			"total" in usage.cost &&
			typeof usage.cost.total === "number"
				? usage.cost.total
				: 0;
		return [
			{
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				cost,
				turns: 1,
				durationMs: 0,
			},
		];
	});
	return sumResourceUsage(turns);
}

function strategyMode(strategy: EvaluationStrategy): "auto" | "direct" | "plan" {
	if (strategy === "planner_worker_reviewer") return "plan";
	if (strategy === "automatic") return "auto";
	return "direct";
}

async function waitForTerminalWorkflow(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	deadlineAtMs: number,
): Promise<WorkflowView | undefined> {
	for (;;) {
		const view = session.getWorkflowView();
		if (!view || ["completed", "failed", "cancelled"].includes(view.workflow.status)) {
			return view;
		}
		if (view.workflow.status === "awaiting_approval") {
			session.decideWorkflowPlan("approve", "Approved by the fixed R16 evaluation protocol");
		}
		const remaining = remainingEvaluationDurationMs(deadlineAtMs);
		if (remaining <= 0) {
			throw new Error("Evaluation Workflow timed out");
		}
		const result = await withTimeout(session.waitForWorkflowAutomation(), remaining, "Evaluation Workflow timed out");
		if (!result || result.terminal) {
			return session.getWorkflowView();
		}
		if (result.waitingReason && !["awaiting_approval", "active_resources"].includes(result.waitingReason)) {
			return session.getWorkflowView();
		}
	}
}

async function runEvaluation(
	taskSet: ReturnType<typeof parseEvaluationTaskSet>,
	task: ReturnType<typeof parseEvaluationTaskSet>["tasks"][number],
	strategy: EvaluationStrategy,
	modelRuntime: ModelRuntime,
	model: Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number],
	modelIdentity: EvaluationModelIdentity,
	artifacts: {
		readonly outputDirectory: string;
		readonly repetition: number;
		readonly keepFailedWorkspaces: boolean;
		readonly keepWorkspaces: boolean;
		readonly taskSetDirectory: string;
		readonly runConfigurationDigest: string;
		readonly routingOptions: ModelRoutingOptions;
		readonly escalationPolicy: EvaluationEscalationPolicy;
	},
): Promise<EvaluationRunRecord> {
	const runRoot = mkdtempSync(join(tmpdir(), `pi-eval-${task.id}-${strategy}-`));
	const workspace = join(runRoot, "repository");
	cpSync(resolve(artifacts.taskSetDirectory, task.repositoryFixture), workspace, { recursive: true });
	await initializeRepository(workspace);
	const protectedPathsBaseline = digestProtectedPaths(workspace, task.protectedPaths);
	const startedAtMs = Date.now();
	const runTimeoutMs = evaluationRunTimeoutMs(artifacts.escalationPolicy, task.budget.maxDurationMs);
	const deadlineAtMs = startedAtMs + runTimeoutMs;
	const startedAt = new Date(startedAtMs).toISOString();
	const limitations: string[] = [
		"Reviewer finding recall uses fixed ground-truth keywords against structured Reviewer Handoffs; semantic equivalents may be undercounted.",
		`Evaluation Bash commands are capped at ${EVALUATION_SHELL_TIMEOUT_SECONDS} seconds and filesystem-root recursive searches are rejected.`,
	];
	let view: WorkflowView | undefined;
	let runtimeFailure: string | undefined;
	let mainSessionUsage = zeroUsage();
	let mainSessionModelNames: readonly string[] = [];
	const sessionReasonCodes: DecisionReasonCode[] = [];
	const softEscalationRoutes: ModelRouteRecord[] = [];
	let promptPromise: Promise<void> | undefined;
	const evaluationSession = SessionManager.inMemory(workspace);
	const modelGateway = new ModelGateway(modelRuntime, artifacts.routingOptions);
	const subagentRuntime = new SubagentRuntime({
		sessionFactory: new RpcSubagentSessionFactory({ thinkingLevel: "medium" }),
		inProcessSessionFactory: new InProcessSubagentSessionFactory(async (config) => {
			const configuredModel = config.profile.model;
			const separator = configuredModel?.indexOf("/") ?? -1;
			const childModel =
				configuredModel && separator > 0
					? modelRuntime.getModel(configuredModel.slice(0, separator), configuredModel.slice(separator + 1))
					: model;
			if (!childModel) {
				throw new Error(`Evaluation Subagent Profile ${config.profile.name} has no available model`);
			}
			const child = await createAgentSession({
				cwd: config.cwd,
				modelRuntime,
				model: childModel,
				thinkingLevel: config.profile.thinkingLevel ?? "medium",
				tools: [...config.toolNames],
				customTools: [createEvaluationBashToolDefinition(config.cwd)],
				sessionManager: SessionManager.inMemory(config.cwd),
			});
			return {
				get sessionId() {
					return child.session.sessionId;
				},
				get messages() {
					return child.session.messages;
				},
				prompt: (message) => child.session.prompt(message),
				steer: (message) => child.session.steer(message),
				abort: () => child.session.abort(),
				waitForIdle: () => child.session.waitForIdle(),
				getSessionStats: () => child.session.getSessionStats(),
				subscribe: (listener) => child.session.subscribe((event) => listener(event)),
				dispose: () => child.session.dispose(),
			};
		}),
		maxAgents: task.budget.maxAgents,
		maxAgentDurationMs: 300_000,
		defaultBackend: "auto",
		modelGateway,
		writeDeniedPaths: task.protectedPaths,
		persistence: new SessionSubagentPersistence(evaluationSession),
	});
	const { session } = await createAgentSession({
		cwd: workspace,
		modelRuntime,
		model,
		modelRouting: modelGateway.options,
		modelRoutingUserOverride: false,
		thinkingLevel: "medium",
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		customTools: [createEvaluationBashToolDefinition(workspace)],
		sessionManager: evaluationSession,
		subagentRuntime,
	});
	const previousPrepareNextTurn = session.agent.prepareNextTurnWithContext;
	let directTurns = 0;
	let softEscalatedModel: typeof model | undefined;
	session.agent.prepareNextTurnWithContext = async (turn, signal) => {
		const snapshot = await previousPrepareNextTurn?.(turn, signal);
		if (softEscalatedModel) {
			return { ...snapshot, model: softEscalatedModel };
		}
		const currentView = session.getWorkflowView();
		if (
			artifacts.routingOptions.enabled !== true ||
			currentView?.workflow.modeDecision?.mode !== "direct" ||
			currentView.workflow.status !== "executing"
		) {
			return snapshot;
		}
		directTurns += 1;
		if (turn.toolResults.length === 0) return snapshot;
		const trigger = evaluationSoftLimitTrigger(artifacts.escalationPolicy, {
			turns: directTurns,
			elapsedMs: Math.max(0, Date.now() - Date.parse(currentView.workflow.createdAt)),
			maxTurns: task.budget.maxTurns,
			maxDurationMs: task.budget.maxDurationMs,
		});
		if (!trigger) return snapshot;
		const currentModel = snapshot?.model ?? session.agent.state.model;
		const currentModelName = `${currentModel.provider}/${currentModel.id}`;
		if (currentModelName === artifacts.routingOptions.strongModel) return snapshot;
		const decision = modelGateway.route({
			role: "main",
			currentModel,
			riskLevel: currentView.workflow.modeDecision.riskLevel,
			escalationReason: "soft_limit",
		});
		if (!decision.model || decision.record.source !== "configured") {
			throw new Error(`Evaluation ${trigger} could not route to the configured Strong model`);
		}
		softEscalatedModel = decision.model;
		softEscalationRoutes.push(decision.record);
		return { ...snapshot, model: softEscalatedModel };
	};
	const unsubscribe = session.subscribe((event) => {
		if ("reasonCode" in event && typeof event.reasonCode === "string") {
			sessionReasonCodes.push(event.reasonCode as DecisionReasonCode);
		}
	});
	try {
		session.enableWorkflowTracking(
			strategyMode(strategy),
			true,
			strategy === "automatic" ? undefined : STRATEGY_PROTOCOLS[strategy],
			{
				maxCost: task.budget.maxCost,
				maxTurns: task.budget.maxTurns,
				maxDurationMs: task.budget.maxDurationMs,
				maxConcurrentAgents: task.budget.maxAgents,
				maxConcurrentJobs: 1,
				maxRetries: artifacts.escalationPolicy.maxRetries,
			},
			task.verificationCommands,
		);
		const prompt = [
			`Evaluation Task: ${task.title}`,
			task.prompt,
			`Success criteria:\n${task.successCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
			`Required verification:\n${task.verificationCommands.map((command) => `- ${command}`).join("\n")}`,
			`Protected verification paths (do not modify):\n${task.protectedPaths.map((path) => `- ${path}`).join("\n")}`,
			`Execution policy: ${EVALUATION_EXECUTION_INSTRUCTION}`,
		].join("\n\n");
		try {
			promptPromise = session.prompt(prompt);
			const promptTimeoutMs = remainingEvaluationDurationMs(deadlineAtMs);
			if (promptTimeoutMs <= 0) throw new Error("Evaluation prompt timed out");
			await withTimeout(promptPromise, promptTimeoutMs, "Evaluation prompt timed out");
			view = await waitForTerminalWorkflow(session, deadlineAtMs);
		} catch (error) {
			runtimeFailure = error instanceof Error ? error.message : String(error);
			try {
				const cleanupResults = await withTimeout(
					Promise.allSettled([
						session.cancelWorkflow(`Evaluation run stopped: ${runtimeFailure}`),
						...(promptPromise ? [promptPromise] : []),
					]),
					30_000,
					"Timed out cleaning up failed Evaluation Workflow",
				);
				const cleanupFailure = cleanupResults[0];
				if (cleanupFailure?.status === "rejected") {
					runtimeFailure += `; cleanup failed: ${
						cleanupFailure.reason instanceof Error ? cleanupFailure.reason.message : String(cleanupFailure.reason)
					}`;
				}
			} catch (cancellationError) {
				runtimeFailure += `; cleanup failed: ${
					cancellationError instanceof Error ? cancellationError.message : String(cancellationError)
				}`;
			}
			view = session.getWorkflowView();
		}
	} finally {
		view ??= session.getWorkflowView();
		mainSessionUsage = usageFromMessages(session.state.messages);
		mainSessionModelNames = actualModelNamesFromMessages(session.state.messages);
		session.exportToJsonl(join(runRoot, "session.jsonl"));
		unsubscribe();
		session.dispose();
		try {
			await withTimeout(subagentRuntime.dispose(), 30_000, "Timed out disposing Evaluation Subagents");
		} catch (error) {
			const disposalFailure = error instanceof Error ? error.message : String(error);
			runtimeFailure = runtimeFailure ? `${runtimeFailure}; cleanup failed: ${disposalFailure}` : disposalFailure;
		}
	}

	const verificationIntegrityPassed = digestProtectedPaths(workspace, task.protectedPaths) === protectedPathsBaseline;
	if (!verificationIntegrityPassed) {
		limitations.push(`Protected verification paths changed: ${task.protectedPaths.join(", ")}`);
	}
	const verificationTimeoutMs = remainingEvaluationDurationMs(deadlineAtMs);
	const verificationResults = !verificationIntegrityPassed
		? task.verificationCommands.map(() => ({
				exitCode: null,
				stdout: "",
				stderr: "Protected verification paths changed during the evaluation run",
				timedOut: false,
			}))
		: verificationTimeoutMs > 0
			? await runVerificationCommands(task, workspace, verificationTimeoutMs)
			: task.verificationCommands.map(() => ({
					exitCode: null,
					stdout: "",
					stderr: "Evaluation duration budget exhausted before external verification",
					timedOut: true,
				}));
	const passedVerifications = verificationResults.filter(
		({ exitCode, timedOut }) => exitCode === 0 && !timedOut,
	).length;
	const agents = view?.agents ?? [];
	const defaultModelName = `${model.provider}/${model.id}`;
	const actualModelNames = [
		...new Set([
			...mainSessionModelNames,
			...agents
				.filter(({ usage: agentUsage }) => agentUsage.turns > 0)
				.map(({ modelRoute, profile }) => modelRoute?.modelName ?? profile?.model ?? defaultModelName),
		]),
	];
	const protocolRuntimeFailure = runtimeFailure?.startsWith("Execution protocol") ?? false;
	const selectedStrategy =
		strategy === "automatic"
			? view?.workflow.modeDecision
				? view.workflow.modeDecision.mode === "direct"
					? "single_agent"
					: "planner_worker_reviewer"
				: undefined
			: strategy;
	const protocolViolations = [
		...(view?.executionProtocol?.violations ??
			(strategy === "automatic" || STRATEGY_PROTOCOLS[strategy].requirements.some(({ required }) => required)
				? ["Workflow did not expose execution protocol state"]
				: [])),
	];
	if (strategy === "automatic" && !selectedStrategy) {
		protocolViolations.push("Automatic strategy did not persist an LLM task classification");
	}
	if (protocolRuntimeFailure && runtimeFailure && !protocolViolations.includes(runtimeFailure)) {
		protocolViolations.push(runtimeFailure);
	}
	const strategyMismatch = task.expectedStrategy !== undefined && task.expectedStrategy !== selectedStrategy;
	if (task.expectedStrategy && task.expectedStrategy !== selectedStrategy) {
		protocolViolations.push(
			`Task expects Strategy ${task.expectedStrategy}, selected ${selectedStrategy ?? "none"} from ${strategy}`,
		);
	}
	const repairTasks = view?.tasks.filter(({ kind }) => kind === "repair") ?? [];
	const persistedHandoffs = new Map(
		new SessionSubagentPersistence(evaluationSession)
			.load()
			.flatMap((record) =>
				record.kind === "checkpoint"
					? record.checkpoint.handoffs
					: record.kind === "state" && record.handoff
						? [record.handoff]
						: [],
			)
			.map((handoff) => [handoff.id, handoff]),
	);
	const reviewerAgentIds = new Set(agents.filter(({ profileName }) => profileName === "reviewer").map(({ id }) => id));
	const reviewerText = [...persistedHandoffs.values()]
		.filter(({ agentId }) => reviewerAgentIds.has(agentId))
		.map((handoff) => JSON.stringify(handoff).toLowerCase())
		.join("\n");
	const validReviewerFindings = task.expectedReviewerFindings.filter((finding) => {
		const keywords = finding
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((keyword) => keyword.length >= 4);
		return keywords.length > 0 && keywords.every((keyword) => reviewerText.includes(keyword));
	}).length;
	const usage = sumResourceUsage([mainSessionUsage, ...agents.map((agent) => agent.usage)]);
	const modelRoutes = [
		...(view?.modelRoutes ?? []),
		...agents.flatMap((agent) => (agent.modelRoute ? [agent.modelRoute] : [])),
		...softEscalationRoutes,
	];
	const requiredModelRoutes = task.expectedModelRoutes?.reduce((total, route) => total + route.minimumCount, 0) ?? 0;
	const reachedRoleCounts: Partial<Record<ModelRouteRole, number>> = {};
	const recordReachedRole = (role: ModelRouteRole): void => {
		reachedRoleCounts[role] = (reachedRoleCounts[role] ?? 0) + 1;
	};
	if (mainSessionUsage.turns > 0) {
		recordReachedRole(selectedStrategy === "planner_worker_reviewer" ? "planner" : "main");
	}
	for (const agent of agents) {
		if (agent.usage.turns === 0 && !agent.modelRoute) continue;
		const role =
			agent.modelRoute?.role ?? task.expectedModelRoutes?.find(({ role }) => role === agent.profileName)?.role;
		if (role) recordReachedRole(role);
	}
	const reachedModelRoutes = countReachedModelRoutes(task.expectedModelRoutes, reachedRoleCounts);
	const matchedModelRoutes =
		task.expectedModelRoutes?.reduce((total, expected) => {
			const matches = modelRoutes.filter(
				(route) => route.role === expected.role && route.tier === expected.tier && route.source === "configured",
			).length;
			const reached = Math.min(reachedRoleCounts[expected.role] ?? 0, expected.minimumCount);
			return total + Math.min(matches, reached);
		}, 0) ?? 0;
	const decisionReasonCodes = [...(view?.decisions.map(({ reasonCode }) => reasonCode) ?? []), ...sessionReasonCodes];
	const automaticDecisionCount = decisionReasonCodes.filter(
		(reasonCode) => !reasonCode.startsWith("mode.user_"),
	).length;
	const budgetExceeded =
		usage.cost > task.budget.maxCost || usage.turns > task.budget.maxTurns || agents.length > task.budget.maxAgents;
	const durationMs = Date.now() - startedAtMs;
	const failedVerification = verificationResults.find(({ exitCode, timedOut }) => exitCode !== 0 || timedOut);
	const infrastructureFailure =
		verificationInfrastructureFailed(verificationResults) ||
		isEvaluationInfrastructureFailure(runtimeFailure) ||
		(usage.turns === 0 &&
			(runtimeFailure?.toLowerCase().includes("timed out") === true ||
				runtimeFailure?.toLowerCase().includes("enoent") === true));
	const protocolStatus = assessEvaluationProtocol({
		violations: protocolViolations,
		protocolStatePresent: view?.executionProtocol !== undefined,
		protocolRunFailedOrIncomplete:
			view?.executionProtocol?.runs.some(({ status }) => status === "failed" || status === "running") ?? false,
		verificationFailed: failedVerification !== undefined,
		verificationIntegrityPassed,
		infrastructureFailure,
		protocolRuntimeFailure: protocolRuntimeFailure || strategyMismatch,
	});
	if (protocolStatus === "violated") {
		limitations.push(`Strategy protocol violations: ${protocolViolations.join("; ")}`);
	} else if (protocolStatus === "not_reached_after_quality_failure") {
		limitations.push(
			`Strategy protocol requirements not reached after quality failure: ${protocolViolations.join("; ")}`,
		);
	}
	const succeeded =
		!runtimeFailure &&
		verificationIntegrityPassed &&
		!budgetExceeded &&
		protocolStatus === "satisfied" &&
		durationMs <= runTimeoutMs &&
		passedVerifications === task.verificationCommands.length;
	const timedOut =
		durationMs > runTimeoutMs ||
		failedVerification?.timedOut === true ||
		runtimeFailure?.toLowerCase().includes("timed out") === true;
	const failureType = classifyEvaluationFailure({
		succeeded,
		verificationIntegrityPassed,
		infrastructureFailure,
		timedOut,
		protocolStatus,
		runtimeFailed: runtimeFailure !== undefined,
		budgetExceeded,
	});
	const failureMessage = !verificationIntegrityPassed
		? `Protected verification paths changed: ${task.protectedPaths.join(", ")}`
		: failureType === "infrastructure"
			? (runtimeFailure ??
				(`${failedVerification?.stderr || failedVerification?.stdout}`.trim() ||
					"Evaluation infrastructure failed"))
			: failureType === "timeout"
				? (runtimeFailure ??
					(`${failedVerification?.stderr || failedVerification?.stdout}`.trim() ||
						`Evaluation exceeded ${runTimeoutMs}ms total timeout (${task.budget.maxDurationMs}ms execution budget plus ${artifacts.escalationPolicy.orchestrationGraceMs}ms orchestration grace)`))
				: protocolStatus === "violated"
					? `Strategy protocol did not complete: ${protocolViolations.join("; ")}`
					: (runtimeFailure ??
						(failedVerification
							? `${failedVerification.stderr || failedVerification.stdout}`.trim().slice(0, 4_000)
							: protocolViolations.length > 0
								? `Strategy protocol did not complete: ${protocolViolations.join("; ")}`
								: undefined));
	const repairSummary = summarizeEvaluationRepairs(
		repairTasks.map(({ status }) => status),
		modelRoutes.filter(({ role }) => role === "repair").length,
		succeeded,
	);
	if (artifacts.keepWorkspaces || (!succeeded && artifacts.keepFailedWorkspaces)) {
		const artifactDirectory = join(
			artifacts.outputDirectory,
			succeeded ? "runs" : "failures",
			`${strategy}-${task.id}-run-${artifacts.repetition}`,
		);
		mkdirSync(dirname(artifactDirectory), { recursive: true });
		writeFileSync(join(runRoot, "workflow-view.json"), `${JSON.stringify(view, null, 2)}\n`, "utf8");
		writeFileSync(
			join(runRoot, "handoffs.json"),
			`${JSON.stringify([...persistedHandoffs.values()], null, 2)}\n`,
			"utf8",
		);
		writeFileSync(
			join(runRoot, "verification-results.json"),
			`${JSON.stringify(verificationResults, null, 2)}\n`,
			"utf8",
		);
		const diff = await runCommand("git diff HEAD --no-ext-diff", workspace, task.budget.maxDurationMs);
		writeFileSync(join(runRoot, "delivery.diff"), diff.stdout, "utf8");
		rmSync(artifactDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		cpSync(runRoot, artifactDirectory, { recursive: true });
		limitations.push(`Run artifacts retained at ${artifactDirectory}`);
	}
	rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		runId: `run-${randomUUID()}`,
		taskSetId: taskSet.id,
		taskSetVersion: taskSet.version,
		taskId: task.id,
		strategy,
		repetition: artifacts.repetition,
		runConfigurationDigest: artifacts.runConfigurationDigest,
		model: modelIdentity,
		repositoryBaseline: task.repositoryBaseline,
		promptDigest: `sha256:${createHash("sha256").update(task.prompt).digest("hex")}`,
		promptVersion: task.promptVersion,
		strategyPromptDigest: `sha256:${createHash("sha256").update(EVALUATION_EXECUTION_INSTRUCTION).digest("hex")}`,
		strategyProtocolVersion: EXECUTION_PROTOCOL_VERSION,
		evaluationProtocolVersion: EVALUATION_PROTOCOL_VERSION,
		escalationPolicy: artifacts.escalationPolicy,
		budget: task.budget,
		startedAt,
		endedAt: new Date().toISOString(),
		succeeded,
		protocolStatus,
		protocolViolations,
		verificationIntegrityPassed,
		requiredVerifications: task.verificationCommands.length,
		passedVerifications,
		reviewerFindings: reviewerAgentIds.size > 0 ? task.expectedReviewerFindings.length : 0,
		validReviewerFindings,
		repairAttempts: repairSummary.attempts,
		successfulRepairs: repairSummary.successes,
		delegations: agents.length + (protocolStatus === "violated" ? protocolViolations.length : 0),
		invalidDelegations:
			agents.filter(({ status, handoffId }) => status === "failed" && !handoffId).length +
			(protocolStatus === "violated" ? protocolViolations.length : 0),
		handoffs: agents.length,
		completeHandoffs: agents.filter(({ handoffId }) => handoffId !== undefined && persistedHandoffs.has(handoffId))
			.length,
		agentCount: agents.length + 1,
		usage: { ...usage, durationMs },
		decisionReasonCodes,
		automaticDecisionCount,
		...(task.difficulty ? { difficulty: task.difficulty } : {}),
		...(task.expectedStrategy ? { expectedStrategy: task.expectedStrategy } : {}),
		...(selectedStrategy ? { selectedStrategy } : {}),
		routingEnabled: modelGateway.options.enabled === true,
		modelRoutes,
		actualModelNames,
		requiredModelRoutes,
		reachedModelRoutes,
		matchedModelRoutes,
		...(task.source ? { taskSource: task.source } : {}),
		failureType,
		failureMessage,
		limitations,
	};
}

const options = parseOptions(process.argv.slice(2));
const taskSetDirectory = dirname(options.taskSetPath);
const taskSet = parseEvaluationTaskSet(JSON.parse(readFileSync(options.taskSetPath, "utf8")));
const invalidBaselines = taskSet.tasks.flatMap((task) => {
	const actual = fixtureDigest(resolve(taskSetDirectory, task.repositoryFixture));
	return actual === task.repositoryBaseline ? [] : [{ taskId: task.id, expected: task.repositoryBaseline, actual }];
});
if (options.verifyTaskSet) {
	let baselineVerificationFailed = false;
	for (const task of taskSet.tasks) {
		const actual = fixtureDigest(resolve(taskSetDirectory, task.repositoryFixture));
		const baseline = await verifyDefectiveBaseline(task, taskSetDirectory);
		console.log(`${task.id}: ${actual}; ${baseline.summary}`);
		baselineVerificationFailed ||= !baseline.valid;
	}
	if (invalidBaselines.length > 0 || baselineVerificationFailed) process.exitCode = 1;
} else {
	if (invalidBaselines.length > 0) {
		throw new Error(`Task Set baseline mismatch:\n${JSON.stringify(invalidBaselines, null, 2)}`);
	}
	const settings = SettingsManager.create(process.cwd());
	const provider = options.provider ?? settings.getDefaultProvider();
	const modelId = options.model ?? settings.getDefaultModel();
	if (!provider || !modelId) {
		throw new Error(
			"Real-model evaluation requires an active Provider and Model; select them with /provider and /model",
		);
	}
	const modelRuntime = await ModelRuntime.create();
	const model = modelRuntime.getModel(
		provider,
		modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId,
	);
	if (!model) {
		throw new Error(`Active Model ${provider}/${modelId} is not available`);
	}
	const modelIdentity: EvaluationModelIdentity = {
		provider: model.provider,
		model: model.id,
		thinkingLevel: "medium",
	};
	process.env.PI_PROVIDER = model.provider;
	process.env.PI_MODEL = model.id;
	const selectedTasks = options.taskIds
		? taskSet.tasks.filter(({ id }) => options.taskIds?.includes(id))
		: taskSet.tasks;
	if (selectedTasks.length === 0 || (options.taskIds && selectedTasks.length !== new Set(options.taskIds).size)) {
		throw new Error(`Unknown or duplicate Task selection: ${options.taskIds?.join(",")}`);
	}
	const selectedTaskSet = options.taskIds
		? { ...taskSet, id: `${taskSet.id}:${selectedTasks.map(({ id }) => id).join("+")}`, tasks: selectedTasks }
		: taskSet;
	const routingOptions = new ModelGateway(modelRuntime).options;
	assertEvaluationEscalationRouting(routingOptions);
	const runConfigurationDigests = new Map<string, string>();
	for (const strategy of options.strategies) {
		for (const task of selectedTasks) {
			runConfigurationDigests.set(
				`${strategy}:${task.id}`,
				evaluationRunConfigurationDigest(selectedTaskSet, task, modelIdentity, EVALUATION_ESCALATION_POLICY),
			);
		}
	}
	const checkpointConfigurationDigestForRepetitions = (repetitions: number): string =>
		digestJson({
			schemaVersion: EVALUATION_SCHEMA_VERSION,
			runConfigurations: [...runConfigurationDigests.entries()],
			repetitions,
			routingOptions,
			escalationPolicy: EVALUATION_ESCALATION_POLICY,
		});
	const checkpointConfigurationDigest = checkpointConfigurationDigestForRepetitions(options.repetitions);
	mkdirSync(options.outputDirectory, { recursive: true });
	const checkpointPath = join(options.outputDirectory, "runs.checkpoint.json");
	const checkpointValue: unknown =
		options.resume && existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) : undefined;
	const checkpointRuns =
		typeof checkpointValue === "object" &&
		checkpointValue !== null &&
		"runs" in checkpointValue &&
		Array.isArray(checkpointValue.runs)
			? checkpointValue.runs
			: [];
	const completedRepetitions = checkpointRuns.flatMap((run) =>
		typeof run === "object" &&
		run !== null &&
		"repetition" in run &&
		typeof run.repetition === "number" &&
		Number.isInteger(run.repetition) &&
		run.repetition > 0
			? [run.repetition]
			: [],
	);
	const previousRepetitionTarget = completedRepetitions.length > 0 ? Math.max(...completedRepetitions) : undefined;
	const persistedCheckpointDigest =
		typeof checkpointValue === "object" &&
		checkpointValue !== null &&
		"configurationDigest" in checkpointValue &&
		typeof checkpointValue.configurationDigest === "string"
			? checkpointValue.configurationDigest
			: undefined;
	const compatibleCheckpointDigest =
		previousRepetitionTarget !== undefined &&
		previousRepetitionTarget <= options.repetitions &&
		persistedCheckpointDigest === checkpointConfigurationDigestForRepetitions(previousRepetitionTarget)
			? persistedCheckpointDigest
			: checkpointConfigurationDigest;
	const runs: EvaluationRunRecord[] = checkpointValue
		? [...parseEvaluationCheckpoint(checkpointValue, compatibleCheckpointDigest).runs]
		: [];
	for (const run of runs) {
		const expectedConfiguration = runConfigurationDigests.get(`${run.strategy}:${run.taskId}`);
		if (!expectedConfiguration || run.runConfigurationDigest !== expectedConfiguration) {
			throw new Error(`Checkpoint run ${run.strategy}/${run.taskId}/${run.repetition} is not comparable`);
		}
	}
	for (const strategy of options.strategies) {
		for (let repetition = 1; repetition <= options.repetitions; repetition++) {
			for (const task of selectedTasks) {
				if (
					runs.some((run) => run.strategy === strategy && run.taskId === task.id && run.repetition === repetition)
				) {
					console.log(`[SKIP] ${strategy} / ${task.id} / ${repetition}`);
					continue;
				}
				console.log(`[RUN] ${strategy} / ${task.id} / ${repetition}`);
				const runConfigurationDigest = runConfigurationDigests.get(`${strategy}:${task.id}`);
				if (!runConfigurationDigest) throw new Error(`Missing run configuration for ${strategy}/${task.id}`);
				const run = await withTaskLocalRuntime(task, taskSetDirectory, () =>
					runEvaluation(selectedTaskSet, task, strategy, modelRuntime, model, modelIdentity, {
						outputDirectory: options.outputDirectory,
						repetition,
						keepFailedWorkspaces: options.keepFailedWorkspaces,
						keepWorkspaces: options.keepWorkspaces,
						taskSetDirectory,
						runConfigurationDigest,
						routingOptions,
						escalationPolicy: EVALUATION_ESCALATION_POLICY,
					}),
				);
				if (run.failureType === "infrastructure") {
					writeFileSync(
						join(options.outputDirectory, "aborted-runs.jsonl"),
						`${JSON.stringify({ ...run, status: "ABORTED" })}\n`,
						{ encoding: "utf8", flag: "a" },
					);
					throw new Error(
						`[ABORTED] ${strategy} / ${task.id} / ${repetition}: ${run.failureMessage ?? "infrastructure failure"}`,
					);
				}
				runs.push(run);
				const checkpoint: EvaluationCheckpoint = {
					schemaVersion: EVALUATION_SCHEMA_VERSION,
					configurationDigest: checkpointConfigurationDigest,
					runs,
				};
				writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
				console.log(`[${run.succeeded ? "PASS" : "FAIL"}] ${strategy} / ${task.id} / ${repetition}`);
			}
		}
	}
	const report = buildEvaluationReport(
		runs,
		options.strategies.includes("single_agent") ? "single_agent" : options.strategies[0],
	);
	mkdirSync(options.outputDirectory, { recursive: true });
	const jsonPath = join(options.outputDirectory, "report.json");
	const markdownPath = join(options.outputDirectory, "report.md");
	writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	writeFileSync(markdownPath, formatEvaluationReportMarkdown(report), "utf8");
	console.log(`Report: ${markdownPath}`);
	if (options.baselineReportPath) {
		const baseline = JSON.parse(readFileSync(options.baselineReportPath, "utf8")) as EvaluationReport;
		const gate = evaluateRegressionGate(baseline, report, report.baselineStrategy);
		writeFileSync(join(options.outputDirectory, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`, "utf8");
		if (!gate.passed) {
			for (const failure of gate.failures) {
				console.error(`[GATE] ${failure.reasonCode}: ${failure.summary}`);
			}
			process.exitCode = 1;
		}
	}
}
