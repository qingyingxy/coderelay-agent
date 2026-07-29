/**
 * R16 Real-model CLI Agent Evaluation
 *
 * Uses the active Provider/Model and a versioned fixture Task Set. Each
 * Strategy receives a fresh Git repository with the same content, Prompt,
 * verification commands, and external budget.
 *
 * Examples:
 *   npm run eval:cli-agent:model -- --verify-task-set
 *   npm run eval:cli-agent:model -- --strategies single_agent,automatic
 *   npm run eval:cli-agent:model -- --output .artifacts/r16-run
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildEvaluationReport,
	createAgentSession,
	type DecisionReasonCode,
	EVALUATION_SCHEMA_VERSION,
	EVALUATION_STRATEGIES,
	type EvaluationModelIdentity,
	type EvaluationReport,
	type EvaluationRunRecord,
	type EvaluationStrategy,
	evaluateRegressionGate,
	formatEvaluationReportMarkdown,
	ModelRuntime,
	parseEvaluationTaskSet,
	SessionManager,
	SessionSubagentPersistence,
	SettingsManager,
	sumResourceUsage,
	type WorkflowView,
} from "@earendil-works/pi-coding-agent";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_SET_PATH = resolve(SCRIPT_DIR, "../../evals/r16/task-set.json");
const TASK_SET_DIR = dirname(TASK_SET_PATH);

const STRATEGY_INSTRUCTIONS: Readonly<Record<EvaluationStrategy, string>> = {
	single_agent:
		"Use only the main Agent. Do not delegate. Diagnose, implement, and verify the task within the main Session.",
	main_explorer:
		'You MUST call the "subagent" tool exactly once with subagentType "explorer" before inspecting or editing. Wait for get_subagent_result, use its Handoff, then implement and verify with the main Agent.',
	main_reviewer:
		'Implement the task with the main Agent, then you MUST call the "subagent" tool exactly once with subagentType "reviewer" before final delivery. Wait for get_subagent_result, address valid findings, and re-run verification.',
	planner_worker_reviewer:
		"Create a dependency-aware Plan. Use a Worker for implementation and a read-only Reviewer before delivery. Keep all execution governed by the Workflow.",
	automatic:
		"Use the automatic Workflow policy. Delegate only when the expected quality gain justifies the added cost, and verify before delivery.",
};

interface EvaluationCliOptions {
	readonly strategies: readonly EvaluationStrategy[];
	readonly taskIds?: readonly string[];
	readonly outputDirectory: string;
	readonly baselineReportPath?: string;
	readonly verifyTaskSet: boolean;
	readonly repetitions: number;
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
	let verifyTaskSet = false;
	let repetitions = 1;
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
		throw new Error(`Unknown option: ${argument}`);
	}
	return { strategies, taskIds, outputDirectory, baselineReportPath, verifyTaskSet, repetitions };
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
	timeoutMs: number,
): Promise<WorkflowView | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const view = session.getWorkflowView();
		if (!view || ["completed", "failed", "cancelled"].includes(view.workflow.status)) {
			return view;
		}
		if (view.workflow.status === "awaiting_approval") {
			session.decideWorkflowPlan("approve", "Approved by the fixed R16 evaluation protocol");
		}
		const remaining = deadline - Date.now();
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
): Promise<EvaluationRunRecord> {
	const runRoot = mkdtempSync(join(tmpdir(), `pi-r16-${task.id}-${strategy}-`));
	const workspace = join(runRoot, "repository");
	cpSync(resolve(TASK_SET_DIR, task.repositoryFixture), workspace, { recursive: true });
	await initializeRepository(workspace);
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const limitations: string[] = [
		"Reviewer finding recall uses fixed ground-truth keywords against structured Reviewer Handoffs; semantic equivalents may be undercounted.",
	];
	let view: WorkflowView | undefined;
	let runtimeFailure: string | undefined;
	let mainSessionUsage = zeroUsage();
	const sessionReasonCodes: DecisionReasonCode[] = [];
	const evaluationSession = SessionManager.inMemory(workspace);
	const { session } = await createAgentSession({
		cwd: workspace,
		modelRuntime,
		model,
		thinkingLevel: "medium",
		sessionManager: evaluationSession,
	});
	const unsubscribe = session.subscribe((event) => {
		if ("reasonCode" in event && typeof event.reasonCode === "string") {
			sessionReasonCodes.push(event.reasonCode as DecisionReasonCode);
		}
	});
	try {
		session.enableWorkflowTracking(strategyMode(strategy), true);
		const prompt = [
			`Evaluation Task: ${task.title}`,
			task.prompt,
			`Success criteria:\n${task.successCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
			`Required verification:\n${task.verificationCommands.map((command) => `- ${command}`).join("\n")}`,
			`Strategy protocol: ${STRATEGY_INSTRUCTIONS[strategy]}`,
		].join("\n\n");
		try {
			await withTimeout(session.prompt(prompt), task.budget.maxDurationMs, "Evaluation prompt timed out");
			view = await waitForTerminalWorkflow(session, task.budget.maxDurationMs);
		} catch (error) {
			runtimeFailure = error instanceof Error ? error.message : String(error);
		}
	} finally {
		mainSessionUsage = usageFromMessages(session.state.messages);
		unsubscribe();
		session.dispose();
	}

	const verificationResults = await Promise.all(
		task.verificationCommands.map((command) => runCommand(command, workspace, task.budget.maxDurationMs)),
	);
	const passedVerifications = verificationResults.filter(
		({ exitCode, timedOut }) => exitCode === 0 && !timedOut,
	).length;
	const agents = view?.agents ?? [];
	const requiredProfiles =
		strategy === "main_explorer"
			? ["explorer"]
			: strategy === "main_reviewer"
				? ["reviewer"]
				: strategy === "planner_worker_reviewer"
					? ["worker", "reviewer"]
					: [];
	const missingProfiles = requiredProfiles.filter(
		(profileName) => !agents.some((agent) => agent.profileName === profileName),
	);
	if (missingProfiles.length > 0) {
		limitations.push(`Strategy protocol missing required Agent Profiles: ${missingProfiles.join(", ")}`);
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
	const decisionReasonCodes = [...(view?.decisions.map(({ reasonCode }) => reasonCode) ?? []), ...sessionReasonCodes];
	const automaticDecisionCount = decisionReasonCodes.filter(
		(reasonCode) => !reasonCode.startsWith("mode.user_"),
	).length;
	const budgetExceeded =
		usage.cost > task.budget.maxCost || usage.turns > task.budget.maxTurns || agents.length > task.budget.maxAgents;
	const durationMs = Date.now() - startedAtMs;
	const succeeded =
		!runtimeFailure &&
		!budgetExceeded &&
		missingProfiles.length === 0 &&
		durationMs <= task.budget.maxDurationMs &&
		passedVerifications === task.verificationCommands.length;
	const failedVerification = verificationResults.find(({ exitCode, timedOut }) => exitCode !== 0 || timedOut);
	const failureType = succeeded
		? undefined
		: runtimeFailure
			? "model"
			: missingProfiles.length > 0
				? "strategy_protocol"
				: budgetExceeded
					? "budget"
					: durationMs > task.budget.maxDurationMs || failedVerification?.timedOut
						? "timeout"
						: "verification";
	const failureMessage =
		runtimeFailure ??
		(missingProfiles.length > 0
			? `Strategy did not create required Agent Profiles: ${missingProfiles.join(", ")}`
			: undefined) ??
		(failedVerification
			? `${failedVerification.stderr || failedVerification.stdout}`.trim().slice(0, 4_000)
			: undefined);
	rmSync(runRoot, { recursive: true, force: true });
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		runId: `run-${randomUUID()}`,
		taskSetId: taskSet.id,
		taskSetVersion: taskSet.version,
		taskId: task.id,
		strategy,
		model: modelIdentity,
		repositoryBaseline: task.repositoryBaseline,
		promptDigest: `sha256:${createHash("sha256").update(task.prompt).digest("hex")}`,
		promptVersion: task.promptVersion,
		strategyPromptDigest: `sha256:${createHash("sha256").update(STRATEGY_INSTRUCTIONS[strategy]).digest("hex")}`,
		strategyProtocolVersion: "r16-strategy-v1",
		budget: task.budget,
		startedAt,
		endedAt: new Date().toISOString(),
		succeeded,
		requiredVerifications: task.verificationCommands.length,
		passedVerifications,
		reviewerFindings: reviewerAgentIds.size > 0 ? task.expectedReviewerFindings.length : 0,
		validReviewerFindings,
		repairAttempts: repairTasks.length,
		successfulRepairs: repairTasks.filter(({ status }) => status === "succeeded").length,
		delegations: agents.length + missingProfiles.length,
		invalidDelegations:
			agents.filter(({ status, handoffId }) => status === "failed" && !handoffId).length + missingProfiles.length,
		handoffs: agents.length,
		completeHandoffs: agents.filter(({ handoffId }) => handoffId !== undefined && persistedHandoffs.has(handoffId))
			.length,
		agentCount: agents.length + 1,
		usage: { ...usage, durationMs },
		decisionReasonCodes,
		automaticDecisionCount,
		failureType,
		failureMessage,
		limitations,
	};
}

const options = parseOptions(process.argv.slice(2));
const taskSet = parseEvaluationTaskSet(JSON.parse(readFileSync(TASK_SET_PATH, "utf8")));
const invalidBaselines = taskSet.tasks.flatMap((task) => {
	const actual = fixtureDigest(resolve(TASK_SET_DIR, task.repositoryFixture));
	return actual === task.repositoryBaseline ? [] : [{ taskId: task.id, expected: task.repositoryBaseline, actual }];
});
if (options.verifyTaskSet) {
	for (const task of taskSet.tasks) {
		const actual = fixtureDigest(resolve(TASK_SET_DIR, task.repositoryFixture));
		console.log(`${task.id}: ${actual}`);
	}
	if (invalidBaselines.length > 0) process.exitCode = 1;
} else {
	if (invalidBaselines.length > 0) {
		throw new Error(`Task Set baseline mismatch:\n${JSON.stringify(invalidBaselines, null, 2)}`);
	}
	const settings = SettingsManager.create(process.cwd());
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	if (!provider || !modelId) {
		throw new Error("R16 evaluation requires an active Provider and Model; select them with /provider and /model");
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
	const selectedTasks = options.taskIds
		? taskSet.tasks.filter(({ id }) => options.taskIds?.includes(id))
		: taskSet.tasks;
	if (selectedTasks.length === 0 || (options.taskIds && selectedTasks.length !== new Set(options.taskIds).size)) {
		throw new Error(`Unknown or duplicate Task selection: ${options.taskIds?.join(",")}`);
	}
	const selectedTaskSet = options.taskIds
		? { ...taskSet, id: `${taskSet.id}:${selectedTasks.map(({ id }) => id).join("+")}`, tasks: selectedTasks }
		: taskSet;
	const runs: EvaluationRunRecord[] = [];
	for (const strategy of options.strategies) {
		for (let repetition = 1; repetition <= options.repetitions; repetition++) {
			for (const task of selectedTasks) {
				console.log(`[RUN] ${strategy} / ${task.id} / ${repetition}`);
				const run = await runEvaluation(selectedTaskSet, task, strategy, modelRuntime, model, modelIdentity);
				runs.push(run);
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
		const gate = evaluateRegressionGate(baseline, report);
		writeFileSync(join(options.outputDirectory, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`, "utf8");
		if (!gate.passed) {
			for (const failure of gate.failures) {
				console.error(`[GATE] ${failure.reasonCode}: ${failure.summary}`);
			}
			process.exitCode = 1;
		}
	}
}
