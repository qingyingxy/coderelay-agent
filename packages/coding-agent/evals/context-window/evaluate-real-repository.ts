/**
 * Serial real-model evaluation over three versioned QuixBugs repositories.
 *
 * Every run crosses three controlled context boundaries, reopens the same
 * Session JSONL after each boundary, and uses deterministic local grading.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
	type AgentSession,
	type ContextManagementMode,
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	type ResourceLoader,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "../../src/index.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DEFAULT_TASK_SET_PATH = join(SCRIPT_DIR, "real-repository-task-set.json");
const DEFAULT_MAX_COST_USD = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 3_000;
const EVALUATION_CONTEXT_WINDOW = 272_000;
const PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const ALLOWED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type AllowedThinkingLevel = (typeof ALLOWED_THINKING_LEVELS)[number];
type JsonPrimitive = string | number | boolean | null;
type RepositoryGroup = "A" | "C";
type VerificationPhase = "initial" | "repair";
type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type CustomTools = NonNullable<CreateSessionOptions["customTools"]>;

interface ModelPrice {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

const OFFICIAL_SHORT_CONTEXT_PRICING: Readonly<Record<string, ModelPrice>> = {
	"gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
	"gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
	"gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
};

interface RepositoryGroupConfiguration {
	readonly group: RepositoryGroup;
	readonly strategy: string;
	readonly mode: ContextManagementMode;
	readonly workflow: boolean;
}

const GROUP_CONFIGURATIONS: readonly RepositoryGroupConfiguration[] = [
	{ group: "A", strategy: "summary", mode: "summary", workflow: false },
	{
		group: "C",
		strategy: "windowed + Workflow Snapshot + Notes + History",
		mode: "windowed",
		workflow: true,
	},
];

export interface RealRepositoryTask {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly durableFacts: readonly string[];
	readonly repositoryFixture: string;
	readonly repositoryBaseline: string;
	readonly editablePath: string;
	readonly referenceSource: string;
	readonly probe: {
		readonly probeId: string;
		readonly memoryToken: string;
		readonly repairMarker: string;
	};
	readonly expectedFinal: Readonly<Record<string, JsonPrimitive>>;
}

export interface RealRepositoryTaskSet {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly tasks: readonly RealRepositoryTask[];
}

export interface RealRepositoryCliOptions {
	readonly provider?: string;
	readonly model?: string;
	readonly thinking: AllowedThinkingLevel;
	readonly taskSetPath: string;
	readonly outputDirectory: string;
	readonly maxCostUsd: number;
	readonly maxOutputTokens: number;
	readonly repetitions: number;
	readonly taskId?: string;
	readonly group?: RepositoryGroup;
	readonly verifyTaskSet: boolean;
}

export interface RepositoryEvaluationCheck {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

export interface RepositoryVerificationResult {
	readonly phase: VerificationPhase;
	readonly passed: boolean;
	readonly officialPassed: boolean;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export interface TaskSetVerificationResult {
	readonly taskId: string;
	readonly expectedBaseline: string;
	readonly actualBaseline: string;
	readonly baselineFailed: boolean;
	readonly referenceReachedHiddenFailure: boolean;
	readonly referenceRepairPassed: boolean;
	readonly passed: boolean;
}

export interface TaskSetVerificationReport {
	readonly schemaVersion: 1;
	readonly taskSetId: string;
	readonly passed: boolean;
	readonly results: readonly TaskSetVerificationResult[];
}

interface EvaluationTokens {
	readonly input: number;
	readonly output: number;
	readonly reasoning: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

interface RepositoryRunMetrics {
	readonly durationMs: number;
	readonly providerCalls: number;
	readonly tokens: EvaluationTokens;
	readonly estimatedCostUsd: number;
	readonly reportedCostUsd: number;
	readonly hardCuts: number;
	readonly summaries: number;
	readonly historyQueries: number;
	readonly historyHits: number;
	readonly noteOperations: number;
	readonly snapshotReferences: number;
	readonly resumes: number;
}

interface VerificationExecution extends RepositoryVerificationResult {
	readonly source: "model" | "runner";
}

interface ResumeEvidence {
	readonly phase: 2 | 3 | 4;
	readonly sameSessionFile: boolean;
	readonly activeContextRestored: boolean;
	readonly branchEntries: number;
}

interface RealRepositoryRunResult {
	readonly taskId: string;
	readonly repetition: number;
	readonly group: RepositoryGroup;
	readonly strategy: string;
	readonly passed: boolean;
	readonly checks: readonly RepositoryEvaluationCheck[];
	readonly metrics: RepositoryRunMetrics;
	readonly phaseReplies: readonly string[];
	readonly boundaryReplies: readonly string[];
	readonly verificationExecutions: readonly VerificationExecution[];
	readonly resumeEvidence: readonly ResumeEvidence[];
	readonly finalResponse: string;
	readonly sessionFile?: string;
	readonly traceFile?: string;
	readonly error?: string;
}

interface RealRepositoryReport {
	readonly schemaVersion: 1;
	readonly taskSetId: string;
	readonly deterministicGrading: true;
	readonly serialExecution: true;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly aborted: boolean;
	readonly configuration: {
		readonly provider: string;
		readonly model: string;
		readonly thinking: AllowedThinkingLevel;
		readonly contextWindow: number;
		readonly maxOutputTokens: number;
		readonly maxCostUsd: number;
		readonly repetitions: number;
		readonly taskId?: string;
		readonly group?: RepositoryGroup;
		readonly pricingPerMillionTokens: ModelPrice;
		readonly pricingSource: string;
	};
	readonly passedRuns: number;
	readonly totalRuns: number;
	readonly plannedRuns: number;
	readonly estimatedCostUsd: number;
	readonly results: readonly RealRepositoryRunResult[];
}

interface InitializedRepositoryFixture {
	readonly workspace: string;
	readonly sourcePath: string;
	readonly initialSourceHash: string;
	readonly initialFiles: readonly string[];
	readonly protectedHashes: ReadonlyMap<string, string>;
}

interface OfficialVerificationResult {
	readonly passed: boolean;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function parseRelativePath(value: unknown, path: string): string {
	const parsed = parseNonEmptyString(value, path).replaceAll("\\", "/");
	if (isAbsolute(parsed) || parsed.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new Error(`${path} must be a normalized relative path`);
	}
	return parsed;
}

function parseStringArray(value: unknown, path: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`${path} must be a non-empty array of non-empty strings`);
	}
	return value;
}

function parsePrimitiveRecord(value: unknown, path: string): Readonly<Record<string, JsonPrimitive>> {
	if (!isRecord(value) || Object.keys(value).length === 0) throw new Error(`${path} must be a non-empty object`);
	for (const [key, item] of Object.entries(value)) {
		if (!key || (!["string", "number", "boolean"].includes(typeof item) && item !== null)) {
			throw new Error(`${path}.${key} must be a JSON primitive`);
		}
	}
	return value as Readonly<Record<string, JsonPrimitive>>;
}

export function parseRealRepositoryTaskSet(value: unknown): RealRepositoryTaskSet {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Task Set schemaVersion must be 1");
	const id = parseNonEmptyString(value.id, "Task Set id");
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error("Task Set tasks must be non-empty");
	const ids = new Set<string>();
	const tasks = value.tasks.map((candidate, index): RealRepositoryTask => {
		const path = `tasks[${index}]`;
		if (!isRecord(candidate) || !isRecord(candidate.probe)) throw new Error(`${path} must contain a probe`);
		const taskId = parseNonEmptyString(candidate.id, `${path}.id`);
		if (ids.has(taskId)) throw new Error(`Duplicate task id: ${taskId}`);
		ids.add(taskId);
		const expectedFinal = parsePrimitiveRecord(candidate.expectedFinal, `${path}.expectedFinal`);
		const memoryToken = parseNonEmptyString(candidate.probe.memoryToken, `${path}.probe.memoryToken`);
		if (expectedFinal.case_id !== taskId) throw new Error(`${path}.expectedFinal.case_id must equal ${taskId}`);
		if (expectedFinal.memory_token !== memoryToken) {
			throw new Error(`${path}.expectedFinal.memory_token must equal the probe memoryToken`);
		}
		const repositoryBaseline = parseNonEmptyString(candidate.repositoryBaseline, `${path}.repositoryBaseline`);
		if (!/^sha256:[0-9a-f]{64}$/.test(repositoryBaseline)) {
			throw new Error(`${path}.repositoryBaseline must be a sha256 digest`);
		}
		return {
			id: taskId,
			title: parseNonEmptyString(candidate.title, `${path}.title`),
			description: parseNonEmptyString(candidate.description, `${path}.description`),
			durableFacts: parseStringArray(candidate.durableFacts, `${path}.durableFacts`),
			repositoryFixture: parseRelativePath(candidate.repositoryFixture, `${path}.repositoryFixture`),
			repositoryBaseline,
			editablePath: parseRelativePath(candidate.editablePath, `${path}.editablePath`),
			referenceSource: parseRelativePath(candidate.referenceSource, `${path}.referenceSource`),
			probe: {
				probeId: parseNonEmptyString(candidate.probe.probeId, `${path}.probe.probeId`),
				memoryToken,
				repairMarker: parseNonEmptyString(candidate.probe.repairMarker, `${path}.probe.repairMarker`),
			},
			expectedFinal,
		};
	});
	return { schemaVersion: 1, id, tasks };
}

function parsePositiveNumber(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive number`);
	return parsed;
}

function parsePositiveInteger(value: string, flag: string): number {
	const parsed = parsePositiveNumber(value, flag);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} requires a positive integer`);
	return parsed;
}

function nextArgument(args: readonly string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function defaultOutputDirectory(): string {
	const suffix = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	return resolve(".artifacts", `context-window-real-repository-${suffix}`);
}

export function parseRealRepositoryCliOptions(args: readonly string[]): RealRepositoryCliOptions {
	let provider: string | undefined;
	let model: string | undefined;
	let thinking: AllowedThinkingLevel = "medium";
	let taskSetPath = DEFAULT_TASK_SET_PATH;
	let outputDirectory = defaultOutputDirectory();
	let maxCostUsd = DEFAULT_MAX_COST_USD;
	let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
	let repetitions = 1;
	let taskId: string | undefined;
	let group: RepositoryGroup | undefined;
	let verifyTaskSet = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--verify-task-set") {
			verifyTaskSet = true;
			continue;
		}
		const value = nextArgument(args, index, argument);
		index++;
		switch (argument) {
			case "--provider":
				provider = value;
				break;
			case "--model":
				model = value;
				break;
			case "--thinking":
				if (!ALLOWED_THINKING_LEVELS.includes(value as AllowedThinkingLevel)) {
					throw new Error(`--thinking must be one of ${ALLOWED_THINKING_LEVELS.join(", ")}`);
				}
				thinking = value as AllowedThinkingLevel;
				break;
			case "--task-set":
				taskSetPath = resolve(value);
				break;
			case "--output":
				outputDirectory = resolve(value);
				break;
			case "--max-cost":
				maxCostUsd = parsePositiveNumber(value, argument);
				break;
			case "--max-output-tokens":
				maxOutputTokens = parsePositiveInteger(value, argument);
				break;
			case "--repetitions":
				repetitions = parsePositiveInteger(value, argument);
				break;
			case "--task":
				taskId = value;
				break;
			case "--group":
				if (value !== "A" && value !== "C") throw new Error("--group must be A or C");
				group = value;
				break;
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}
	return {
		provider,
		model,
		thinking,
		taskSetPath,
		outputDirectory,
		maxCostUsd,
		maxOutputTokens,
		repetitions,
		taskId,
		group,
		verifyTaskSet,
	};
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function repositoryFiles(root: string, directory = root): string[] {
	const files: string[] = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) files.push(...repositoryFiles(root, path));
		else files.push(path);
	}
	return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export function repositoryDigest(root: string): string {
	const hash = createHash("sha256");
	for (const path of repositoryFiles(root)) {
		hash.update(relative(root, path).replaceAll("\\", "/"));
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

function relativeWorkspaceFiles(root: string): string[] {
	return repositoryFiles(root).map((path) => relative(root, path).replaceAll("\\", "/"));
}

function protectedFileHashes(workspace: string, editablePath: string): ReadonlyMap<string, string> {
	const hashes = new Map<string, string>();
	for (const path of repositoryFiles(workspace)) {
		const relativePath = relative(workspace, path).replaceAll("\\", "/");
		if (relativePath !== editablePath) hashes.set(relativePath, sha256(readFileSync(path)));
	}
	return hashes;
}

export function initializeRepositoryFixture(
	root: string,
	taskSetDirectory: string,
	task: RealRepositoryTask,
): InitializedRepositoryFixture {
	const fixturePath = resolve(taskSetDirectory, task.repositoryFixture);
	if (!existsSync(fixturePath)) throw new Error(`Repository fixture does not exist: ${fixturePath}`);
	const actualBaseline = repositoryDigest(fixturePath);
	if (actualBaseline !== task.repositoryBaseline) {
		throw new Error(`Repository baseline mismatch for ${task.id}: expected ${task.repositoryBaseline}, got ${actualBaseline}`);
	}
	const workspace = join(root, "workspace");
	cpSync(fixturePath, workspace, { recursive: true });
	const sourcePath = join(workspace, task.editablePath);
	if (!existsSync(sourcePath)) throw new Error(`Editable source does not exist: ${task.editablePath}`);
	return {
		workspace,
		sourcePath,
		initialSourceHash: sha256(readFileSync(sourcePath)),
		initialFiles: relativeWorkspaceFiles(workspace),
		protectedHashes: protectedFileHashes(workspace, task.editablePath),
	};
}

function runOfficialVerification(workspace: string): OfficialVerificationResult {
	const result = spawnSync(process.execPath, [join(workspace, "verify.mjs")], {
		cwd: workspace,
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
	const stderr = [result.error?.message, result.stderr].filter(Boolean).join("\n").trim();
	return {
		passed: result.status === 0,
		exitCode: result.status,
		stdout: result.stdout.trim(),
		stderr,
	};
}

function requiredMarkerLine(task: RealRepositoryTask): string {
	return `CW_RECOVERY_MARKER = ${JSON.stringify(task.probe.repairMarker)}`;
}

export function runRepositoryFixtureVerification(
	root: string,
	task: RealRepositoryTask,
	phase: VerificationPhase,
): RepositoryVerificationResult {
	const workspace = join(root, "workspace");
	const official = runOfficialVerification(workspace);
	if (!official.passed) {
		return {
			phase,
			passed: false,
			officialPassed: false,
			exitCode: official.exitCode,
			stdout: official.stdout,
			stderr: official.stderr,
		};
	}
	const markerLine = requiredMarkerLine(task);
	const source = readFileSync(join(workspace, task.editablePath), "utf8");
	if (!source.split(/\r?\n/).includes(markerLine)) {
		return {
			phase,
			passed: false,
			officialPassed: true,
			exitCode: 1,
			stdout: official.stdout,
			stderr: `HIDDEN_REPAIR_REQUIRED: add the exact line ${markerLine} to ${task.editablePath} without changing the repaired behavior.`,
		};
	}
	return {
		phase,
		passed: true,
		officialPassed: true,
		exitCode: 0,
		stdout: [official.stdout, `verification:${phase}:passed; marker=${task.probe.repairMarker}`]
			.filter(Boolean)
			.join("\n"),
		stderr: "",
	};
}

export function verifyRealRepositoryTaskSet(
	taskSet: RealRepositoryTaskSet,
	taskSetDirectory: string,
): TaskSetVerificationReport {
	const results: TaskSetVerificationResult[] = [];
	for (const task of taskSet.tasks) {
		const fixturePath = resolve(taskSetDirectory, task.repositoryFixture);
		const referencePath = resolve(taskSetDirectory, task.referenceSource);
		const actualBaseline = repositoryDigest(fixturePath);
		const baseline = runOfficialVerification(fixturePath);
		const root = mkdtempSync(join(tmpdir(), `pi-cw-real-repository-${task.id}-`));
		let referenceReachedHiddenFailure = false;
		let referenceRepairPassed = false;
		try {
			const workspace = join(root, "workspace");
			cpSync(fixturePath, workspace, { recursive: true });
			const referenceSource = readFileSync(referencePath, "utf8");
			writeFileSync(join(workspace, task.editablePath), referenceSource, "utf8");
			const initial = runRepositoryFixtureVerification(root, task, "initial");
			referenceReachedHiddenFailure =
				!initial.passed && initial.officialPassed && initial.stderr.includes("HIDDEN_REPAIR_REQUIRED");
			writeFileSync(
				join(workspace, task.editablePath),
				`${requiredMarkerLine(task)}\n${referenceSource}`,
				"utf8",
			);
			referenceRepairPassed = runRepositoryFixtureVerification(root, task, "repair").passed;
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		const result = {
			taskId: task.id,
			expectedBaseline: task.repositoryBaseline,
			actualBaseline,
			baselineFailed: !baseline.passed,
			referenceReachedHiddenFailure,
			referenceRepairPassed,
			passed:
				actualBaseline === task.repositoryBaseline &&
				!baseline.passed &&
				referenceReachedHiddenFailure &&
				referenceRepairPassed,
		};
		results.push(result);
	}
	return {
		schemaVersion: 1,
		taskSetId: taskSet.id,
		passed: results.every(({ passed }) => passed),
		results,
	};
}

function createResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () =>
			"Run the controlled multi-window repository evaluation. Work only in the copied repository, follow each phase literally, and use the requested tools exactly. Do not inspect parent directories or evaluator files.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function createProbeTool(task: RealRepositoryTask) {
	return defineTool({
		name: "benchmark_probe",
		label: "Benchmark probe",
		description: `Read immutable continuity ledger ${task.probe.probeId}.`,
		promptSnippet: "Read one immutable benchmark probe by probe_id",
		parameters: Type.Object({ probe_id: Type.Literal(task.probe.probeId) }),
		executionMode: "sequential",
		execute: async () => {
			const details = { probe_id: task.probe.probeId, memory_token: task.probe.memoryToken };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}

function createVerificationTool(root: string, task: RealRepositoryTask, executions: VerificationExecution[]) {
	return defineTool({
		name: "benchmark_verify",
		label: "Benchmark verify",
		description: "Run the isolated deterministic verifier for the requested repository phase.",
		promptSnippet: "Run the controlled repository verifier with phase initial or repair",
		parameters: Type.Object({ phase: Type.Union([Type.Literal("initial"), Type.Literal("repair")]) }),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const result = runRepositoryFixtureVerification(root, task, params.phase);
			executions.push({ ...result, source: "model" });
			if (!result.passed) throw new Error([result.stderr, result.stdout].filter(Boolean).join("\n"));
			return { content: [{ type: "text" as const, text: result.stdout }], details: result };
		},
	});
}

function lastAssistantEntry(branch: readonly SessionEntry[]): {
	readonly id: string;
	readonly text: string;
} | null {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return { id: entry.id, text };
	}
	return null;
}

function toolResultEntries(
	branch: readonly SessionEntry[],
	toolName: string,
): Array<Extract<SessionEntry, { type: "message" }>> {
	return branch.filter(
		(entry): entry is Extract<SessionEntry, { type: "message" }> =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === toolName,
	);
}

function collectReasoningTokens(branch: readonly SessionEntry[]): number {
	let reasoning = 0;
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			reasoning += entry.message.usage.reasoning ?? 0;
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			reasoning += entry.usage.reasoning ?? 0;
		}
	}
	return reasoning;
}

function calculateEstimatedCost(tokens: EvaluationTokens, price: ModelPrice): number {
	return (
		(tokens.input * price.input +
			tokens.cacheRead * price.cacheRead +
			tokens.cacheWrite * price.cacheWrite +
			tokens.output * price.output) /
		1_000_000
	);
}

function collectMetrics(
	session: AgentSession,
	price: ModelPrice,
	startedAt: number,
	resumes: number,
): RepositoryRunMetrics {
	const stats = session.getSessionStats();
	const trace = session.getContextManagementTrace();
	const tokens: EvaluationTokens = {
		input: stats.tokens.input,
		output: stats.tokens.output,
		reasoning: collectReasoningTokens(session.sessionManager.getBranch()),
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		total: stats.tokens.total,
	};
	return {
		durationMs: Date.now() - startedAt,
		providerCalls: stats.assistantMessages + trace.stats.summaries.count,
		tokens,
		estimatedCostUsd: calculateEstimatedCost(tokens, price),
		reportedCostUsd: stats.cost,
		hardCuts: trace.stats.hardCuts.count,
		summaries: trace.stats.summaries.count,
		historyQueries: trace.stats.history.queryCount,
		historyHits: trace.historyQueries.reduce((sum, query) => sum + query.resultCount, 0),
		noteOperations: trace.stats.notes.operationCount,
		snapshotReferences: trace.windows.filter((window) => window.snapshotEntryId !== undefined).length,
		resumes,
	};
}

function emptyMetrics(startedAt: number, resumes: number): RepositoryRunMetrics {
	return {
		durationMs: Date.now() - startedAt,
		providerCalls: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		estimatedCostUsd: 0,
		reportedCostUsd: 0,
		hardCuts: 0,
		summaries: 0,
		historyQueries: 0,
		historyHits: 0,
		noteOperations: 0,
		snapshotReferences: 0,
		resumes,
	};
}

function ensureBudget(session: AgentSession, completedCostUsd: number, maxCostUsd: number, price: ModelPrice): void {
	const current = collectMetrics(session, price, Date.now(), 0).estimatedCostUsd;
	if (completedCostUsd + current > maxCostUsd) {
		throw new Error(
			`Evaluation budget exceeded: $${(completedCostUsd + current).toFixed(6)} > $${maxCostUsd.toFixed(2)}`,
		);
	}
}

function phaseOnePrompt(task: RealRepositoryTask, hardCut: boolean): string {
	return [
		"Phase 1: inspect the repository and immutable continuity ledger without modifying files.",
		`External case_id: ${task.id}`,
		`Task: ${task.description}`,
		`Read PROVENANCE.md, ${task.editablePath}, and the files under test/.`,
		...(hardCut
			? [
					"Call notes exactly once with these arguments:",
					JSON.stringify({
						action: "upsert",
						note_id: `${task.id}-constraints`,
						category: "constraint",
						content: task.durableFacts.join(" "),
						source_entry_ids: [],
					}),
					"Do not put benchmark probe output into Notes.",
				]
			: []),
		`Call benchmark_probe exactly once with {"probe_id":${JSON.stringify(task.probe.probeId)}}.`,
		"Do not edit files, quote the probe result, or add a visible explanation.",
		"Reply exactly PHASE_ONE_READY.",
	].join("\n");
}

function phaseTwoPrompt(task: RealRepositoryTask): string {
	return [
		"Phase 2: diagnose the real defect without modifying files.",
		`External case_id: ${task.id}`,
		`Read ${task.editablePath} and the official tests again.`,
		"Identify the smallest behavioral repair internally, but do not edit or run verification yet.",
		"Reply exactly DIAGNOSIS_READY with no explanation.",
	].join("\n");
}

function phaseThreePrompt(task: RealRepositoryTask): string {
	return [
		"Phase 3: implement the diagnosed QuixBugs repair.",
		`External case_id: ${task.id}`,
		`Edit only ${task.editablePath}; preserve its public function and documentation.`,
		"Do not add CW_RECOVERY_MARKER or guess any hidden repair before verification reports it.",
		'After editing, call benchmark_verify exactly once with {"phase":"initial"}.',
		"If verification reports HIDDEN_REPAIR_REQUIRED, do not apply it or retry in this phase.",
		"Reply exactly REPAIR_REQUIRED.",
	].join("\n");
}

function phaseFourPrompt(task: RealRepositoryTask, hardCut: boolean): string {
	const failureHistory = {
		action: "search",
		query: "HIDDEN_REPAIR_REQUIRED",
		role: "toolResult",
		tool: "benchmark_verify",
		window_id: null,
		entry_ids: null,
		cursor: null,
		limit: 10,
	};
	const probeHistory = {
		action: "search",
		query: task.probe.probeId,
		role: "toolResult",
		tool: "benchmark_probe",
		window_id: null,
		entry_ids: null,
		cursor: null,
		limit: 10,
	};
	return [
		"Phase 4: recover long-range evidence, apply the hidden repair, and finish.",
		`External case_id: ${task.id}`,
		...(hardCut
			? [
					"Call history exactly twice, once with each argument object below:",
					JSON.stringify(failureHistory),
					JSON.stringify(probeHistory),
					"Use the old verifier result for the exact marker line and the old probe result for memory_token.",
				]
			: ["Use the compacted summary to recover both the exact hidden failure and the first-window memory_token."]),
		`Read ${task.editablePath}, apply only the exact hidden repair, and edit no other file.`,
		'Call benchmark_verify exactly once with {"phase":"repair"}.',
		`After it passes, return exactly ${JSON.stringify(task.expectedFinal)} with no Markdown or explanation.`,
	].join("\n");
}

function boundaryPrompt(boundary: 1 | 2 | 3, hardCut: boolean, task: RealRepositoryTask): string {
	const lines = [
		`Controlled boundary ${boundary}. Do not inspect or edit files in this turn.`,
		`Non-authoritative boundary padding: ${"archive-padding ".repeat(256)}`,
	];
	if (!hardCut) return [...lines, `Reply exactly WINDOW_${boundary}_READY without calling a tool.`].join("\n");
	if (boundary > 1) {
		lines.push(
			"Call notes exactly once with these arguments:",
			JSON.stringify({
				action: "upsert",
				note_id: `${task.id}-phase-${boundary}`,
				category: "open_question",
				content:
					boundary === 2
						? "Repository diagnosis is complete; implement the real defect after the next boundary."
						: "Official tests pass but hidden verification requires exact History recovery after the next boundary.",
				source_entry_ids: [],
			}),
			"Do not include probe output or the exact verifier failure in Notes.",
		);
	}
	lines.push(
		"Call new_context exactly once with an empty object and do not call any other tool afterward.",
		`When new_context is no longer available in the fresh window, reply exactly WINDOW_${boundary}_READY.`,
	);
	return lines.join("\n");
}

function compactionInstruction(boundary: 1 | 2 | 3): string {
	if (boundary === 1) return "Preserve the exact benchmark_probe output and repository constraints for final delivery.";
	if (boundary === 2) return "Preserve the first-window benchmark_probe output, repository constraints, and completed diagnosis.";
	return "Preserve the first-window benchmark_probe output and the exact HIDDEN_REPAIR_REQUIRED verifier message.";
}

function check(id: string, passed: boolean, detail: string): RepositoryEvaluationCheck {
	return { id, passed, detail };
}

function extractJsonObject(text: string): Readonly<Record<string, unknown>> | null {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	try {
		const parsed: unknown = JSON.parse(fenced?.[1] ?? trimmed);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function evaluateRepositoryFinalResponse(
	text: string,
	task: RealRepositoryTask,
): readonly RepositoryEvaluationCheck[] {
	const parsed = extractJsonObject(text);
	const expectedKeys = Object.keys(task.expectedFinal);
	const actualKeys = parsed ? Object.keys(parsed) : [];
	const checks = [
		check("final-json", parsed !== null, parsed ? "final response is a JSON object" : "final response is not JSON"),
		check(
			"final-keys",
			parsed !== null && JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
			`expected keys ${expectedKeys.join(", ")}; received ${actualKeys.join(", ") || "none"}`,
		),
	];
	for (const [key, expected] of Object.entries(task.expectedFinal)) {
		checks.push(check(`final-value:${key}`, parsed?.[key] === expected, `${key} must equal ${JSON.stringify(expected)}`));
	}
	return checks;
}

async function createRepositorySession(options: {
	readonly workspace: string;
	readonly sessionManager: SessionManager;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly configuration: RepositoryGroupConfiguration;
	readonly customTools: CustomTools;
	readonly includeNewContext: boolean;
}): Promise<AgentSession> {
	const hardCut = options.configuration.group === "C";
	const tools = ["read", "edit", "write", "benchmark_probe", "benchmark_verify"];
	if (hardCut) tools.push("notes", "history");
	if (hardCut && options.includeNewContext) tools.push("new_context");
	const created = await createAgentSession({
		cwd: options.workspace,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinkingLevel: options.thinking,
		tools,
		customTools: options.customTools,
		resourceLoader: createResourceLoader(),
		sessionManager: options.sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 4_000 },
			contextManagement: {
				mode: options.configuration.mode,
				reserveTokens: 16_000,
				notesHintMaxBytes: 4_000,
				historyResultMaxBytes: 16_000,
			},
			retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 180_000 } },
		}),
	});
	if (options.configuration.workflow) created.session.enableWorkflowTracking("direct");
	return created.session;
}

async function createControlledBoundary(options: {
	readonly session: AgentSession;
	readonly boundary: 1 | 2 | 3;
	readonly task: RealRepositoryTask;
	readonly configuration: RepositoryGroupConfiguration;
	readonly completedCostUsd: number;
	readonly maxCostUsd: number;
	readonly price: ModelPrice;
}): Promise<string> {
	const hardCut = options.configuration.group === "C";
	const before = options.session.getContextManagementTrace();
	let unsubscribe = () => {};
	if (hardCut) {
		let completed = false;
		unsubscribe = options.session.subscribe((event) => {
			if (completed || event.type !== "context_window_end" || event.reason !== "model") return;
			completed = true;
			options.session.setActiveToolsByName(
				options.session.getActiveToolNames().filter((name) => name !== "new_context"),
			);
		});
	}
	try {
		await options.session.prompt(boundaryPrompt(options.boundary, hardCut, options.task));
		ensureBudget(options.session, options.completedCostUsd, options.maxCostUsd, options.price);
		if (!hardCut) {
			const compacted = await options.session.compactForCommand(compactionInstruction(options.boundary));
			if (compacted.strategy !== "summary") throw new Error(`Expected summary boundary, got ${compacted.strategy}`);
			ensureBudget(options.session, options.completedCostUsd, options.maxCostUsd, options.price);
		}
	} finally {
		unsubscribe();
	}
	const after = options.session.getContextManagementTrace();
	const beforeCount = hardCut ? before.stats.hardCuts.count : before.stats.summaries.count;
	const afterCount = hardCut ? after.stats.hardCuts.count : after.stats.summaries.count;
	if (afterCount !== beforeCount + 1) {
		throw new Error(`Boundary ${options.boundary} did not create exactly one ${hardCut ? "hard cut" : "summary"}`);
	}
	return lastAssistantEntry(options.session.sessionManager.getBranch())?.text ?? "";
}

async function reopenRepositorySession(options: {
	readonly session: AgentSession;
	readonly sessionsDirectory: string;
	readonly workspace: string;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly configuration: RepositoryGroupConfiguration;
	readonly customTools: CustomTools;
	readonly phase: 2 | 3 | 4;
}): Promise<{ session: AgentSession; manager: SessionManager; evidence: ResumeEvidence }> {
	const sessionFile = options.session.sessionFile;
	if (!sessionFile || !existsSync(sessionFile)) throw new Error("Session JSONL is unavailable before resume");
	const activeBefore = JSON.stringify(options.session.messages);
	options.session.dispose();
	const manager = SessionManager.open(sessionFile, options.sessionsDirectory);
	const session = await createRepositorySession({
		workspace: options.workspace,
		sessionManager: manager,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinking: options.thinking,
		configuration: options.configuration,
		customTools: options.customTools,
		includeNewContext: options.phase < 4,
	});
	return {
		session,
		manager,
		evidence: {
			phase: options.phase,
			sameSessionFile: session.sessionFile === sessionFile,
			activeContextRestored: JSON.stringify(session.messages) === activeBefore,
			branchEntries: manager.getBranch().length,
		},
	};
}

function protectedFilesUnchanged(
	workspace: string,
	protectedHashes: ReadonlyMap<string, string>,
): { readonly passed: boolean; readonly changed: readonly string[] } {
	const changed: string[] = [];
	for (const [relativePath, expectedHash] of protectedHashes) {
		const path = join(workspace, relativePath);
		if (!existsSync(path) || sha256(readFileSync(path)) !== expectedHash) changed.push(relativePath);
	}
	return { passed: changed.length === 0, changed };
}

async function runRepositoryCase(options: {
	readonly task: RealRepositoryTask;
	readonly taskSetDirectory: string;
	readonly repetition: number;
	readonly configuration: RepositoryGroupConfiguration;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly price: ModelPrice;
	readonly outputDirectory: string;
	readonly completedCostUsd: number;
	readonly maxCostUsd: number;
}): Promise<RealRepositoryRunResult> {
	const { task, configuration, modelRuntime, model, thinking, price, completedCostUsd, maxCostUsd } = options;
	const startedAt = Date.now();
	const runDirectory = join(
		options.outputDirectory,
		`repeat-${String(options.repetition).padStart(2, "0")}`,
		`${task.id}-${configuration.group}`,
	);
	const sessionsDirectory = join(runDirectory, "sessions");
	mkdirSync(sessionsDirectory, { recursive: true });
	const fixture = initializeRepositoryFixture(runDirectory, options.taskSetDirectory, task);
	const verificationExecutions: VerificationExecution[] = [];
	const customTools: CustomTools = [createProbeTool(task), createVerificationTool(runDirectory, task, verificationExecutions)];
	let manager = SessionManager.create(fixture.workspace, sessionsDirectory);
	let session: AgentSession | undefined;
	const phaseReplies: string[] = [];
	const boundaryReplies: string[] = [];
	const resumeEvidence: ResumeEvidence[] = [];
	let probeEntryId: string | undefined;
	let diagnosisEntryId: string | undefined;
	let initialVerificationEntryId: string | undefined;
	let probeExcludedAfterBoundary = false;
	let diagnosisExcludedAfterBoundary = false;
	let failureExcludedAfterBoundary = false;
	let sourceUnchangedBeforeImplementation = false;
	let prematureMarker = false;
	let finalResponse = "";
	let independentVerification: RepositoryVerificationResult | undefined;
	let error: string | undefined;
	try {
		session = await createRepositorySession({
			workspace: fixture.workspace,
			sessionManager: manager,
			modelRuntime,
			model,
			thinking,
			configuration,
			customTools,
			includeNewContext: true,
		});
		await session.prompt(phaseOnePrompt(task, configuration.group === "C"));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		phaseReplies.push(lastAssistantEntry(manager.getBranch())?.text ?? "");
		probeEntryId = toolResultEntries(manager.getBranch(), "benchmark_probe").at(-1)?.id;
		boundaryReplies.push(
			await createControlledBoundary({
				session,
				boundary: 1,
				task,
				configuration,
				completedCostUsd,
				maxCostUsd,
				price,
			}),
		);
		probeExcludedAfterBoundary =
			probeEntryId !== undefined && !manager.buildContextEntries().some(({ id }) => id === probeEntryId);

		let reopened = await reopenRepositorySession({
			session,
			sessionsDirectory,
			workspace: fixture.workspace,
			modelRuntime,
			model,
			thinking,
			configuration,
			customTools,
			phase: 2,
		});
		session = reopened.session;
		manager = reopened.manager;
		resumeEvidence.push(reopened.evidence);
		await session.prompt(phaseTwoPrompt(task));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		const diagnosis = lastAssistantEntry(manager.getBranch());
		phaseReplies.push(diagnosis?.text ?? "");
		diagnosisEntryId = diagnosis?.id;
		sourceUnchangedBeforeImplementation = sha256(readFileSync(fixture.sourcePath)) === fixture.initialSourceHash;
		boundaryReplies.push(
			await createControlledBoundary({
				session,
				boundary: 2,
				task,
				configuration,
				completedCostUsd,
				maxCostUsd,
				price,
			}),
		);
		diagnosisExcludedAfterBoundary =
			diagnosisEntryId !== undefined && !manager.buildContextEntries().some(({ id }) => id === diagnosisEntryId);

		reopened = await reopenRepositorySession({
			session,
			sessionsDirectory,
			workspace: fixture.workspace,
			modelRuntime,
			model,
			thinking,
			configuration,
			customTools,
			phase: 3,
		});
		session = reopened.session;
		manager = reopened.manager;
		resumeEvidence.push(reopened.evidence);
		await session.prompt(phaseThreePrompt(task));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		phaseReplies.push(lastAssistantEntry(manager.getBranch())?.text ?? "");
		initialVerificationEntryId = toolResultEntries(manager.getBranch(), "benchmark_verify").at(-1)?.id;
		prematureMarker = readFileSync(fixture.sourcePath, "utf8").includes(task.probe.repairMarker);
		boundaryReplies.push(
			await createControlledBoundary({
				session,
				boundary: 3,
				task,
				configuration,
				completedCostUsd,
				maxCostUsd,
				price,
			}),
		);
		failureExcludedAfterBoundary =
			initialVerificationEntryId !== undefined &&
			!manager.buildContextEntries().some(({ id }) => id === initialVerificationEntryId);

		reopened = await reopenRepositorySession({
			session,
			sessionsDirectory,
			workspace: fixture.workspace,
			modelRuntime,
			model,
			thinking,
			configuration,
			customTools,
			phase: 4,
		});
		session = reopened.session;
		manager = reopened.manager;
		resumeEvidence.push(reopened.evidence);
		await session.prompt(phaseFourPrompt(task, configuration.group === "C"));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		finalResponse = lastAssistantEntry(manager.getBranch())?.text ?? "";
		phaseReplies.push(finalResponse);
		independentVerification = runRepositoryFixtureVerification(runDirectory, task, "repair");
		verificationExecutions.push({ ...independentVerification, source: "runner" });
	} catch (caught) {
		error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
	}

	const branch = manager.getBranch();
	const trace = session?.getContextManagementTrace();
	const hardCut = configuration.group === "C";
	const boundaries = branch.filter((entry) => entry.type === "context_window");
	const noteEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === "memory-note");
	const modelVerifications = verificationExecutions.filter(({ source }) => source === "model");
	const initialVerification = modelVerifications.find(({ phase }) => phase === "initial");
	const repairVerification = modelVerifications.find(({ phase }) => phase === "repair");
	const finalSource = readFileSync(fixture.sourcePath, "utf8");
	const finalFiles = relativeWorkspaceFiles(fixture.workspace);
	const protectedStatus = protectedFilesUnchanged(fixture.workspace, fixture.protectedHashes);
	const checks: RepositoryEvaluationCheck[] = [
		...evaluateRepositoryFinalResponse(finalResponse, task),
		check("phase-one-reply", phaseReplies[0] === "PHASE_ONE_READY", `received ${JSON.stringify(phaseReplies[0])}`),
		check("phase-two-reply", phaseReplies[1] === "DIAGNOSIS_READY", `received ${JSON.stringify(phaseReplies[1])}`),
		check("phase-three-reply", phaseReplies[2] === "REPAIR_REQUIRED", `received ${JSON.stringify(phaseReplies[2])}`),
		check(
			"boundary-replies",
			boundaryReplies.length === 3 && boundaryReplies.every((reply) => reply.trim().length > 0),
			`received ${JSON.stringify(boundaryReplies)}`,
		),
		check("probe-called-once", toolResultEntries(branch, "benchmark_probe").length === 1, "one probe result exists"),
		check("probe-excluded-after-boundary", probeExcludedAfterBoundary, "first-window probe left active context"),
		check("diagnosis-excluded-after-boundary", diagnosisExcludedAfterBoundary, "diagnosis left active context"),
		check("failure-excluded-after-boundary", failureExcludedAfterBoundary, "hidden failure left active context"),
		check("source-unchanged-before-implementation", sourceUnchangedBeforeImplementation, "phase 1 and 2 made no source edit"),
		check(
			"initial-verification-reached-hidden-failure",
			modelVerifications.filter(({ phase }) => phase === "initial").length === 1 &&
				initialVerification?.passed === false &&
				initialVerification.officialPassed &&
				initialVerification.stderr.includes("HIDDEN_REPAIR_REQUIRED"),
			"one initial verification passed official tests and produced the controlled hidden failure",
		),
		check("repair-not-premature", !prematureMarker, "hidden marker was absent before the third boundary"),
		check(
			"repair-verification-passed",
			modelVerifications.filter(({ phase }) => phase === "repair").length === 1 && repairVerification?.passed === true,
			"one model-requested repair verification passed",
		),
		check(
			"independent-verification-passed",
			independentVerification?.passed === true,
			"runner independently re-ran the official and hidden verifier",
		),
		check("source-changed", sha256(finalSource) !== fixture.initialSourceHash, `${task.editablePath} changed`),
		check(
			"protected-files-unchanged",
			protectedStatus.passed,
			protectedStatus.passed ? "all non-editable files are unchanged" : `changed: ${protectedStatus.changed.join(", ")}`,
		),
		check(
			"workspace-files-isolated",
			JSON.stringify(finalFiles) === JSON.stringify(fixture.initialFiles),
			`workspace files: ${finalFiles.join(", ")}`,
		),
		check(
			"three-disk-resumes",
			resumeEvidence.length === 3 &&
				resumeEvidence.every(({ sameSessionFile, activeContextRestored }) => sameSessionFile && activeContextRestored),
			"all three AgentSession recreations restored the same JSONL context",
		),
		check(
			"full-history-retained",
			probeEntryId !== undefined &&
				initialVerificationEntryId !== undefined &&
				manager.getEntry(probeEntryId) !== undefined &&
				manager.getEntry(initialVerificationEntryId) !== undefined,
			"old probe and verifier entries remain in the complete branch",
		),
	];
	if (trace) {
		const requiredHistorySearches = [
			{ query: "HIDDEN_REPAIR_REQUIRED", tool: "benchmark_verify" },
			{ query: task.probe.probeId, tool: "benchmark_probe" },
		].every((required) =>
			trace.historyQueries.some(
				({ request, resultCount }) =>
					request !== null &&
					request.action === "search" &&
					request.query === required.query &&
					request.tool === required.tool &&
					resultCount >= 1,
			),
		);
		checks.push(
			check(
				"three-boundaries",
				hardCut
					? trace.stats.hardCuts.count === 3 && trace.stats.summaries.count === 0
					: trace.stats.summaries.count === 3 && trace.stats.hardCuts.count === 0,
				`hard cuts=${trace.stats.hardCuts.count}; summaries=${trace.stats.summaries.count}`,
			),
			check(
				"window-lineage",
				!hardCut ||
					(boundaries.length === 3 &&
						boundaries.every((entry, index) => entry.windowIndex === index + 1) &&
						boundaries[1]?.previousWindowId === boundaries[0]?.windowId &&
						boundaries[2]?.previousWindowId === boundaries[1]?.windowId &&
						boundaries.every((entry) => entry.firstWindowId === boundaries[0]?.firstWindowId)),
				hardCut ? "three hard windows form one persisted lineage" : "summary baseline has no hard-window lineage",
			),
			check(
				"history-route",
				hardCut ? requiredHistorySearches : trace.stats.history.queryCount === 0,
				`History queries=${trace.stats.history.queryCount}`,
			),
			check(
				"notes-route",
				hardCut ? trace.stats.notes.operationCount === 3 : trace.stats.notes.operationCount === 0,
				`Note operations=${trace.stats.notes.operationCount}`,
			),
			check(
				"snapshot-route",
				hardCut
					? trace.windows.filter(({ snapshotEntryId }) => snapshotEntryId !== undefined).length === 3
					: trace.windows.length === 0,
				`Snapshot references=${trace.windows.filter(({ snapshotEntryId }) => snapshotEntryId !== undefined).length}`,
			),
			check(
				"notes-exclude-hidden-values",
				!JSON.stringify(noteEntries).includes(task.probe.memoryToken) &&
					!JSON.stringify(noteEntries).includes(task.probe.repairMarker),
				"Notes contain neither the first-window token nor the hidden repair marker",
			),
		);
	}
	const metrics = session
		? collectMetrics(session, price, startedAt, resumeEvidence.length)
		: emptyMetrics(startedAt, resumeEvidence.length);
	const traceFile = trace ? join(runDirectory, "context-management-trace.json") : undefined;
	if (traceFile && trace) writeFileSync(traceFile, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
	writeFileSync(join(runDirectory, "final-source.py"), finalSource, "utf8");
	writeFileSync(join(runDirectory, "final-response.txt"), `${finalResponse}\n`, "utf8");
	writeFileSync(join(runDirectory, "resume-evidence.json"), `${JSON.stringify(resumeEvidence, null, 2)}\n`, "utf8");
	const result: RealRepositoryRunResult = {
		taskId: task.id,
		repetition: options.repetition,
		group: configuration.group,
		strategy: configuration.strategy,
		passed: error === undefined && checks.every(({ passed }) => passed),
		checks,
		metrics,
		phaseReplies,
		boundaryReplies,
		verificationExecutions,
		resumeEvidence,
		finalResponse,
		...(session?.sessionFile ? { sessionFile: session.sessionFile } : {}),
		...(traceFile ? { traceFile } : {}),
		...(error ? { error } : {}),
	};
	writeFileSync(join(runDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
	session?.dispose();
	return result;
}

function markdownReport(report: RealRepositoryReport): string {
	const rows = report.results.map((result) => {
		const metrics = result.metrics;
		return `| ${result.repetition} | ${result.group} | ${result.taskId} | ${result.passed ? "PASS" : "FAIL"} | ${metrics.resumes} | ${metrics.hardCuts}/${metrics.summaries} | ${metrics.historyQueries}/${metrics.historyHits} | ${metrics.noteOperations} | ${metrics.snapshotReferences} | ${metrics.providerCalls} | ${metrics.tokens.input} | ${metrics.tokens.output} | $${metrics.estimatedCostUsd.toFixed(6)} | ${metrics.durationMs} |`;
	});
	return [
		"# Repeated Real-Repository Multi-Window Evaluation",
		"",
		`- Task Set: \`${report.taskSetId}\``,
		`- Model: \`${report.configuration.provider}/${report.configuration.model}\``,
		`- Thinking: \`${report.configuration.thinking}\``,
		"- Execution: strictly serial",
		`- Result: ${report.passedRuns}/${report.totalRuns} passed${report.aborted ? " (aborted)" : ""}`,
		`- Estimated cost: $${report.estimatedCostUsd.toFixed(6)} / $${report.configuration.maxCostUsd.toFixed(2)}`,
		`- Pricing: [OpenAI API pricing](${report.configuration.pricingSource})`,
		"",
		"| Repeat | Group | Task | Result | Resumes | Hard/Summary | History q/h | Notes | Snapshots | Calls | Input | Output | Cost | ms |",
		"|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
		...rows,
		"",
	].join("\n");
}

function writeCheckpoint(
	path: string,
	configuration: RealRepositoryReport["configuration"],
	taskSetId: string,
	results: readonly RealRepositoryRunResult[],
): void {
	writeFileSync(
		path,
		`${JSON.stringify({ schemaVersion: 1, taskSetId, serialExecution: true, configuration, results }, null, 2)}\n`,
		"utf8",
	);
}

async function runRealRepositoryEvaluation(
	options: RealRepositoryCliOptions,
	taskSet: RealRepositoryTaskSet,
): Promise<RealRepositoryReport> {
	const settings = SettingsManager.create(process.cwd());
	const provider = options.provider ?? settings.getDefaultProvider();
	const requestedModel = options.model ?? settings.getDefaultModel();
	if (!provider || !requestedModel) {
		throw new Error("Real repository evaluation requires --provider and --model, or active Pi provider/model settings");
	}
	const modelId = requestedModel.includes("/") ? requestedModel.slice(requestedModel.indexOf("/") + 1) : requestedModel;
	const price = OFFICIAL_SHORT_CONTEXT_PRICING[modelId];
	if (!price) throw new Error(`No pinned official short-context price for model ${modelId}`);
	const modelRuntime = await ModelRuntime.create();
	const configuredModel = modelRuntime.getModel(provider, modelId);
	if (!configuredModel) throw new Error(`Model ${provider}/${modelId} is not available`);
	if (!modelRuntime.hasConfiguredAuth(provider)) throw new Error(`Provider ${provider} has no configured authentication`);
	const model: Model<Api> = {
		...configuredModel,
		contextWindow: Math.min(configuredModel.contextWindow, EVALUATION_CONTEXT_WINDOW),
		maxTokens: Math.min(configuredModel.maxTokens, options.maxOutputTokens),
		cost: price,
	};
	const tasks = options.taskId ? taskSet.tasks.filter(({ id }) => id === options.taskId) : taskSet.tasks;
	if (tasks.length === 0) throw new Error(`Task ${options.taskId} is not present in ${taskSet.id}`);
	const groups = options.group
		? GROUP_CONFIGURATIONS.filter(({ group }) => group === options.group)
		: GROUP_CONFIGURATIONS;
	const configuration: RealRepositoryReport["configuration"] = {
		provider,
		model: model.id,
		thinking: options.thinking,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		maxCostUsd: options.maxCostUsd,
		repetitions: options.repetitions,
		...(options.taskId ? { taskId: options.taskId } : {}),
		...(options.group ? { group: options.group } : {}),
		pricingPerMillionTokens: price,
		pricingSource: PRICING_SOURCE,
	};
	if (existsSync(join(options.outputDirectory, "report.json"))) {
		throw new Error(`Output directory already contains a report: ${options.outputDirectory}`);
	}
	mkdirSync(options.outputDirectory, { recursive: true });
	const startedAt = new Date().toISOString();
	const results: RealRepositoryRunResult[] = [];
	let completedCostUsd = 0;
	let aborted = false;
	const checkpointPath = join(options.outputDirectory, "checkpoint.json");
	for (let repetition = 1; repetition <= options.repetitions; repetition++) {
		for (const task of tasks) {
			for (const group of groups) {
				if (completedCostUsd >= options.maxCostUsd) {
					aborted = true;
					break;
				}
				console.log(`[RUN] repeat ${repetition} / ${group.group} / ${task.id} / serial`);
				const result = await runRepositoryCase({
					task,
					taskSetDirectory: dirname(options.taskSetPath),
					repetition,
					configuration: group,
					modelRuntime,
					model,
					thinking: options.thinking,
					price,
					outputDirectory: options.outputDirectory,
					completedCostUsd,
					maxCostUsd: options.maxCostUsd,
				});
				results.push(result);
				completedCostUsd += result.metrics.estimatedCostUsd;
				writeCheckpoint(checkpointPath, configuration, taskSet.id, results);
				console.log(
					`[${result.passed ? "PASS" : "FAIL"}] repeat ${repetition} / ${group.group} / ${task.id} / $${result.metrics.estimatedCostUsd.toFixed(6)} / cumulative $${completedCostUsd.toFixed(6)}`,
				);
				if (result.error) {
					aborted = true;
					break;
				}
			}
			if (aborted) break;
		}
		if (aborted) break;
	}
	const passedRuns = results.filter(({ passed }) => passed).length;
	const report: RealRepositoryReport = {
		schemaVersion: 1,
		taskSetId: taskSet.id,
		deterministicGrading: true,
		serialExecution: true,
		startedAt,
		completedAt: new Date().toISOString(),
		aborted,
		configuration,
		passedRuns,
		totalRuns: results.length,
		plannedRuns: options.repetitions * tasks.length * groups.length,
		estimatedCostUsd: completedCostUsd,
		results,
	};
	writeFileSync(join(options.outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	writeFileSync(join(options.outputDirectory, "report.md"), markdownReport(report), "utf8");
	return report;
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === resolve(SCRIPT_PATH) : false;
if (isMain) {
	const options = parseRealRepositoryCliOptions(process.argv.slice(2));
	const taskSet = parseRealRepositoryTaskSet(JSON.parse(readFileSync(options.taskSetPath, "utf8")));
	if (options.verifyTaskSet) {
		const report = verifyRealRepositoryTaskSet(taskSet, dirname(options.taskSetPath));
		console.log(JSON.stringify(report, null, 2));
		if (!report.passed) process.exitCode = 1;
	} else {
		const report = await runRealRepositoryEvaluation(options, taskSet);
		console.log(`Report: ${join(options.outputDirectory, "report.md")}`);
		if (report.aborted || report.passedRuns !== report.totalRuns) process.exitCode = 1;
	}
}
