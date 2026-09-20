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
import { prepareCompaction } from "../../src/core/compaction/index.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DEFAULT_TASK_SET_PATH = join(SCRIPT_DIR, "real-repository-task-set.json");
const DEFAULT_MAX_COST_USD = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 3_000;
const EVALUATION_CONTEXT_WINDOW = 272_000;
const SUMMARY_KEEP_RECENT_TOKENS = 1;
const PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const ALLOWED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type AllowedThinkingLevel = (typeof ALLOWED_THINKING_LEVELS)[number];
type JsonPrimitive = string | number | boolean | null;
type RepositoryGroup = "A" | "C";
type BoundaryTrigger = "runner" | "model";
type VerificationPhase = "initial" | "repair";
type MemoryPolicy = "scripted" | "autonomous";
type GovernanceScenario = "continuity" | "changed-requirement" | "stale-evidence" | "interrupted-operation";
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
	readonly boundaryTrigger: BoundaryTrigger;
	readonly verifyTaskSet: boolean;
	readonly memoryPolicy: MemoryPolicy;
	readonly scenario: GovernanceScenario;
	readonly summaryKeepRecentTokens: number;
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

export interface VerificationExecution extends RepositoryVerificationResult {
	readonly source: "model" | "runner";
	readonly sourceHash?: string;
	readonly markerPresentBeforeCall?: boolean;
}

interface ResumeEvidence {
	readonly phase: 2 | 3 | 4;
	readonly sameSessionFile: boolean;
	readonly activeContextRestored: boolean;
	readonly branchEntries: number;
}

interface BoundaryEvidence {
	readonly boundary: 1 | 2 | 3;
	readonly requestedTrigger: BoundaryTrigger | "summary";
	readonly actualReason: string;
	readonly boundaryEntryId?: string;
	readonly modelReply: string;
	readonly newContextCalls: number;
	readonly postCutToolNames: readonly string[];
}

interface BoundaryProtocolMetrics {
	readonly trigger: BoundaryTrigger;
	readonly opportunities: number;
	readonly modelTriggered: number;
	readonly runnerTriggered: number;
	readonly modelTriggerMisses: number;
	readonly newContextCalls: number;
	readonly duplicateNewContextCalls: number;
	readonly postCutToolCalls: number;
	readonly redundantProbeCalls: number;
}

interface RealRepositoryRunResult {
	readonly taskId: string;
	readonly repetition: number;
	readonly group: RepositoryGroup;
	readonly strategy: string;
	readonly passed: boolean;
	readonly memoryPassed: boolean;
	readonly protocolPassed: boolean;
	readonly recoveryPassed: boolean;
	readonly evidenceExposure: {
		readonly probeExcludedAfterBoundary: boolean;
		readonly diagnosisExcludedAfterBoundary: boolean;
		readonly failureExcludedAfterBoundary: boolean;
		readonly crossBoundaryRecoveryExercised: boolean;
	};
	readonly checks: readonly RepositoryEvaluationCheck[];
	readonly protocolChecks: readonly RepositoryEvaluationCheck[];
	readonly metrics: RepositoryRunMetrics;
	readonly boundaryProtocol: BoundaryProtocolMetrics;
	readonly phaseReplies: readonly string[];
	readonly boundaryReplies: readonly string[];
	readonly boundaryEvidence: readonly BoundaryEvidence[];
	readonly verificationExecutions: readonly VerificationExecution[];
	readonly resumeEvidence: readonly ResumeEvidence[];
	readonly finalResponse: string;
	readonly sessionFile?: string;
	readonly traceFile?: string;
	readonly error?: string;
}

interface RealRepositoryReport {
	readonly schemaVersion: 2;
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
		readonly boundaryTrigger: BoundaryTrigger;
		readonly phasePromptProtocol: "matched-v5" | "autonomous-v3";
		readonly evaluationKind: "controlled-memory-stress" | "controlled-autonomous-memory";
		readonly memoryPolicy: MemoryPolicy;
		readonly scenario: GovernanceScenario;
		readonly summaryKeepRecentTokens: number;
		readonly phasePromptHashes: Readonly<Record<string, string>>;
		readonly pricingPerMillionTokens: ModelPrice;
		readonly pricingSource: string;
	};
	readonly passedRuns: number;
	readonly protocolPassedRuns: number;
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
	let boundaryTrigger: BoundaryTrigger = "runner";
	let verifyTaskSet = false;
	let memoryPolicy: MemoryPolicy = "scripted";
	let scenario: GovernanceScenario = "continuity";
	let summaryKeepRecentTokens = SUMMARY_KEEP_RECENT_TOKENS;
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
			case "--summary-keep-recent-tokens":
				summaryKeepRecentTokens = parsePositiveInteger(value, argument);
				if (summaryKeepRecentTokens >= EVALUATION_CONTEXT_WINDOW - 16_000) {
					throw new Error("--summary-keep-recent-tokens must leave room for the context reserve");
				}
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
			case "--boundary-trigger":
				if (value !== "runner" && value !== "model") {
					throw new Error("--boundary-trigger must be runner or model");
				}
				boundaryTrigger = value;
				break;
			case "--memory-policy":
				if (value !== "scripted" && value !== "autonomous") throw new Error("--memory-policy must be scripted or autonomous");
				memoryPolicy = value;
				break;
			case "--scenario":
				if (value !== "continuity" && value !== "changed-requirement" && value !== "stale-evidence" && value !== "interrupted-operation") {
					throw new Error("--scenario must be continuity, changed-requirement, stale-evidence, or interrupted-operation");
				}
				scenario = value;
				break;
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}
	if (scenario !== "continuity" && memoryPolicy !== "autonomous") throw new Error("Governance scenarios require --memory-policy autonomous");
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
		boundaryTrigger,
		verifyTaskSet,
		memoryPolicy,
		scenario,
		summaryKeepRecentTokens,
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

function repositoryPhase(branch: readonly SessionEntry[]): number {
	const entry = branch.filter((item) => item.type === "custom" && item.customType === "benchmark-phase").at(-1);
	return entry?.type === "custom" && isRecord(entry.data) && typeof entry.data.phase === "number" ? entry.data.phase : 1;
}

export function createEvidenceStatusTool(getManager: () => SessionManager) {
	return defineTool({
		name: "benchmark_evidence_status",
		label: "Evidence status",
		description: "Inspect branch-local one-shot tool availability and persisted result entry IDs without consuming or redisclosing evidence. A consumed claim does not guarantee a result was persisted. Recover closed evidence from retained context, Notes, or History; never repeat a closed call.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		execute: async () => {
			const branch = getManager().getBranch();
			const phase = repositoryPhase(branch);
			const tools = [
				{ tool: "benchmark_probe", claim: "benchmark-probe-claimed", phase: 1 },
				{ tool: "benchmark_verify", claim: "benchmark-verification-initial", phase: 3 },
				{ tool: "benchmark_verify", claim: "benchmark-verification-repair", phase: 4 },
			].map((spec) => {
				const claim = branch.find((entry) => entry.type === "custom" && entry.customType === spec.claim);
				const callId = claim?.type === "custom" && isRecord(claim.data) ? claim.data.toolCallId : undefined;
				const result = typeof callId === "string" ? branch.find((entry) => entry.type === "message" &&
					entry.message.role === "toolResult" && entry.message.toolName === spec.tool && entry.message.toolCallId === callId) : undefined;
				const boundaryClosed = spec.tool === "benchmark_probe" && branch.some((entry) => entry.type === "compaction" || entry.type === "context_window");
				return {
					tool: spec.tool,
					phase: spec.phase,
					state: claim ? "consumed" : phase === spec.phase && !boundaryClosed ? "available" : "unavailable",
					claimEntryId: claim?.id ?? null,
					resultEntryId: result?.id ?? null,
					resultRecorded: result !== undefined,
				};
			});
			const details = { phase, tools };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}

export function createProbeTool(task: RealRepositoryTask, getManager: () => SessionManager) {
	return defineTool({
		name: "benchmark_probe",
		label: "Benchmark probe",
		description: `Read immutable continuity ledger ${task.probe.probeId} once in the first window. Later calls cannot disclose it again.`,
		promptSnippet: "Read one immutable benchmark probe by probe_id",
		parameters: Type.Object({ probe_id: Type.Literal(task.probe.probeId) }),
		executionMode: "sequential",
		execute: async (toolCallId) => {
			const manager = getManager();
			const branch = manager.getBranch();
			if (repositoryPhase(branch) !== 1 || branch.some((entry) => entry.type === "compaction" || entry.type === "context_window" ||
				(entry.type === "custom" && entry.customType === "benchmark-probe-claimed"))) {
				throw new Error("PROBE_ALREADY_CLOSED: use previously retained evidence; no new disclosure is available.");
			}
			// Commit consumption before disclosing, so recreation cannot reset the one-shot ledger.
			manager.appendCustomEntry("benchmark-probe-claimed", { probeId: task.probe.probeId, toolCallId });
			const details = { probe_id: task.probe.probeId, memory_token: task.probe.memoryToken };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}

export function createVerificationTool(root: string, task: RealRepositoryTask, executions: VerificationExecution[], getManager: () => SessionManager) {
	return defineTool({
		name: "benchmark_verify",
		label: "Benchmark verify",
		description: "Run verification once per phase. Initial verification discloses the hidden requirement only in window 2; repair never discloses its value.",
		promptSnippet: "Run the controlled repository verifier with phase initial or repair",
		parameters: Type.Object({ phase: Type.Union([Type.Literal("initial"), Type.Literal("repair")]) }),
		executionMode: "sequential",
		execute: async (toolCallId, params) => {
			const manager = getManager();
			const branch = manager.getBranch();
			if (repositoryPhase(branch) !== (params.phase === "initial" ? 3 : 4) || branch.some((entry) =>
				entry.type === "custom" && entry.customType === `benchmark-verification-${params.phase}`)) {
				throw new Error("VERIFICATION_CLOSED: this phase is unavailable or has already been used; recover earlier evidence.");
			}
			manager.appendCustomEntry(`benchmark-verification-${params.phase}`, { phase: params.phase, toolCallId });
			const source = readFileSync(join(root, "workspace", task.editablePath), "utf8");
			const result = runRepositoryFixtureVerification(root, task, params.phase);
			const sourceHash = `sha256:${sha256(source)}`;
			executions.push({ ...result, source: "model", sourceHash, markerPresentBeforeCall: source.split(/\r?\n/).includes(requiredMarkerLine(task)) });
			if (!result.passed) throw new Error(params.phase === "initial"
				? [result.stderr, result.stdout].filter(Boolean).join("\n")
				: `REPAIR_VERIFICATION_FAILED: officialPassed=${result.officialPassed}; recover original evidence. sourceHash=${sourceHash}`);
			const details = { phase: params.phase, passed: true, sourceHash };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}

export async function executeRepositoryPhase(session: Pick<AgentSession, "prompt" | "sessionManager">, prompt: string): Promise<{
	readonly id: string;
	readonly text: string;
}> {
	const previous = new Set(session.sessionManager.getBranch().map(({ id }) => id));
	await session.prompt(prompt);
	const replies = session.sessionManager.getBranch().filter((entry): entry is Extract<SessionEntry, { type: "message" }> =>
		!previous.has(entry.id) && entry.type === "message" && entry.message.role === "assistant");
	for (const entry of replies) {
		if (entry.message.role === "assistant" && (entry.message.stopReason === "error" || entry.message.stopReason === "aborted")) {
			throw new Error(`PROVIDER_PHASE_FAILED: ${entry.message.errorMessage ?? entry.message.stopReason}; entry=${entry.id}`);
		}
	}
	const last = replies.at(-1);
	if (!last || last.message.role !== "assistant") throw new Error("PHASE_REPLY_MISSING: no new assistant reply");
	const text = last.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
	if (!text) throw new Error(`PHASE_REPLY_MISSING: final assistant reply contains no text; entry=${last.id}`);
	return { id: last.id, text };
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

function phaseOnePrompt(task: RealRepositoryTask): string {
	return [
		"Phase 1: inspect the repository and immutable continuity ledger without modifying files.",
		`External case_id: ${task.id}`,
		`Task: ${task.description}`,
		`Read PROVENANCE.md, ${task.editablePath}, and the files under test/.`,
		"If the notes tool is available, call it exactly once with these arguments:",
		JSON.stringify({
			action: "upsert",
			note_id: `${task.id}-constraints`,
			category: "constraint",
			content: task.durableFacts.join(" "),
			source_entry_ids: [],
		}),
		"If notes is unavailable, continue without a Notes call.",
		"Do not put benchmark probe output into Notes.",
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
		"If the notes tool is available, call it exactly once with these arguments:",
		JSON.stringify({
			action: "upsert",
			note_id: `${task.id}-phase-2`,
			category: "open_question",
			content: "Repository diagnosis is complete; implement the real defect after the next boundary.",
			source_entry_ids: [],
		}),
		"If notes is unavailable, continue without a Notes call.",
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
		"If the notes tool is available, after verification call it exactly once with these arguments:",
		JSON.stringify({
			action: "upsert",
			note_id: `${task.id}-phase-3`,
			category: "open_question",
			content: "Official tests pass but hidden verification requires exact History recovery after the next boundary.",
			source_entry_ids: [],
		}),
		"If notes is unavailable, continue without a Notes call.",
		"Do not include the exact verifier failure in Notes.",
		"Reply exactly REPAIR_REQUIRED.",
	].join("\n");
}

function phaseFourPrompt(task: RealRepositoryTask): string {
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
		"If the history tool is available, call it exactly twice, once with each argument object below:",
		JSON.stringify(failureHistory),
		JSON.stringify(probeHistory),
		"If history is unavailable, recover the same values from the active context without a History call.",
		"Use the old verifier result for the exact marker line and the old probe result for memory_token.",
		`Read ${task.editablePath}, apply only the exact hidden repair, and edit no other file.`,
		"Do not call verification until the exact recovered marker line is present in the editable file.",
		'Call benchmark_verify exactly once with {"phase":"repair"}.',
		`After it passes, return one JSON object with keys in this order: case_id, status, memory_token. Set case_id to ${JSON.stringify(task.id)}, status to "passed", and memory_token to the exact value recovered from the old probe result. Do not include Markdown or explanation.`,
	].join("\n");
}

export function repositoryPhasePrompts(task: RealRepositoryTask, policy: MemoryPolicy = "scripted", scenario: GovernanceScenario = "continuity"): readonly [string, string, string, string] {
	const evidencePolicy = "Before using a one-shot evidence tool after resume, inspect benchmark_evidence_status. If consumed or unavailable, recover the original result from retained context, Notes, or History. Missing evidence does not authorize another probe or an already-consumed verification. A persisted claim alone is not proof that its result was recorded.";
	const prompts: [string, string, string, string] = policy === "scripted" ? [phaseOnePrompt(task), phaseTwoPrompt(task), phaseThreePrompt(task), phaseFourPrompt(task)] : [
		[
			"Phase 1: inspect the repository and continuity ledger without modifying files.",
			`External case_id: ${task.id}. Task: ${task.description}`,
			`Read PROVENANCE.md, ${task.editablePath}, and the files under test/.`,
			...task.durableFacts,
			"Manage durable information using the available tools as you judge necessary. Files may only contain the requested code changes.",
			`Call benchmark_probe exactly once with {"probe_id":${JSON.stringify(task.probe.probeId)}}. Its value is needed at final delivery and will not be disclosed again.`,
			...(scenario === "changed-requirement" ? ['Final delivery must also contain delivery_label="draft".'] : []),
			...(scenario === "interrupted-operation" ? ["After the repair, ensure the repository operation is committed exactly once. Its durable receipt can be inspected through benchmark_operation; retrying a committed operation is forbidden."] : []),
			"Do not edit files or quote the probe result in the visible reply. Reply exactly PHASE_ONE_READY.",
		].join("\n"),
		[
			"Phase 2: diagnose the real defect without modifying files or running verification.",
			`External case_id: ${task.id}. Read ${task.editablePath} and the official tests.`,
			...(scenario === "changed-requirement" ? ['Requirement update: delivery_label="approved" replaces the earlier "draft" requirement. Only the new label is valid for final delivery.'] : []),
			"Reply exactly DIAGNOSIS_READY with no explanation.",
		].join("\n"),
		[
			"Phase 3: implement the diagnosed repository repair.",
			`External case_id: ${task.id}. Edit only ${task.editablePath}; preserve its public function and documentation.`,
			"Do not add CW_RECOVERY_MARKER or guess any hidden repair before verification reports it.",
			'After editing, call benchmark_verify exactly once with {"phase":"initial"}.',
			"If it reports HIDDEN_REPAIR_REQUIRED, preserve what you need to finish later. Do not apply it or retry in this phase.",
			...(scenario === "stale-evidence" ? ["The workspace can change while this session is suspended. Verification results apply only to the source revision they tested."] : []),
			...(scenario === "interrupted-operation" ? ["An external worker will attempt the repository operation during suspension. Its acknowledgement may be lost; the eventual operation outcome will need reconciliation."] : []),
			"Reply exactly REPAIR_REQUIRED.",
		].join("\n"),
		[
			"Phase 4: resume work, complete the repair, and deliver the result using previously observed evidence.",
			`External case_id: ${task.id}. Inspect the current ${task.editablePath}; edit no other file.`,
			"Recover the original verifier requirement and the original continuity token. Do not guess missing values.",
			...(scenario === "stale-evidence" ? ["Reconcile current source with the suspended work and fix any intervening regression before delivery."] : []),
			"Apply the exact required marker line before verification; the repair verifier will not disclose it again.",
			'Call benchmark_verify exactly once with {"phase":"repair"} after the final edit.',
			...(scenario === "interrupted-operation" ? ["Reconcile the pending repository operation so it is committed exactly once."] : []),
			`After success, return one JSON object with keys in this order: case_id, status, memory_token${scenario === "changed-requirement" ? ", delivery_label" : ""}. Set case_id to ${JSON.stringify(task.id)}, status to "passed", and memory_token to the original continuity token.${scenario === "changed-requirement" ? " Use the latest user requirement for delivery_label." : ""} Do not include Markdown or explanation.`,
		].join("\n"),
	];
	return [prompts[0], `${evidencePolicy}\n${prompts[1]}`, `${evidencePolicy}\n${prompts[2]}`, `${evidencePolicy}\n${prompts[3]}`];
}

export function repositoryPhasePromptHash(task: RealRepositoryTask, policy: MemoryPolicy = "scripted", scenario: GovernanceScenario = "continuity"): string {
	return `sha256:${sha256(repositoryPhasePrompts(task, policy, scenario).join("\0phase\0"))}`;
}

interface OperationReceipt {
	readonly committed: boolean;
	readonly commits: number;
	readonly applyAttempts: number;
	readonly inspections: number;
}

export function createOperationTool(root: string) {
	const path = join(root, "operation-receipt.json");
	return defineTool({
		name: "benchmark_operation",
		label: "Repository operation",
		description: "Inspect the durable receipt or apply the repository operation. A duplicate apply is a protocol violation even when the durable guard prevents a second commit.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("inspect"), Type.Literal("apply")]) }),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const receipt: OperationReceipt = JSON.parse(readFileSync(path, "utf8"));
			const updated = params.action === "inspect"
				? { ...receipt, inspections: receipt.inspections + 1 }
				: { ...receipt, committed: true, commits: receipt.committed ? receipt.commits : receipt.commits + 1, applyAttempts: receipt.applyAttempts + 1 };
			writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
			if (params.action === "apply" && receipt.committed) throw new Error("OPERATION_ALREADY_COMMITTED: duplicate apply attempt recorded.");
			return { content: [{ type: "text" as const, text: JSON.stringify(updated) }], details: updated };
		},
	});
}

export function injectGovernanceIntervention(root: string, task: RealRepositoryTask, scenario: GovernanceScenario): void {
	const sourcePath = join(root, "workspace", task.editablePath);
	const before = readFileSync(sourcePath, "utf8");
	if (scenario === "stale-evidence") {
		writeFileSync(sourcePath, `${before}\nraise RuntimeError("CW_EXTERNAL_REVISION")\n`);
	}
	if (scenario === "interrupted-operation") {
		const receipt: OperationReceipt = JSON.parse(readFileSync(join(root, "operation-receipt.json"), "utf8"));
		writeFileSync(join(root, "operation-receipt.json"), `${JSON.stringify({ ...receipt, committed: true, commits: receipt.commits + 1 }, null, 2)}\n`);
	}
	writeFileSync(join(root, "intervention.json"), `${JSON.stringify({ scenario, beforeSourceHash: `sha256:${sha256(before)}`, afterSourceHash: `sha256:${sha256(readFileSync(sourcePath))}`, kind: scenario === "interrupted-operation" ? "simulated-committed-effect-without-acknowledgement" : scenario }, null, 2)}\n`);
}

function boundaryPrompt(boundary: 1 | 2 | 3): string {
	const lines = [
		`Controlled boundary ${boundary}. Do not inspect or edit files in this turn.`,
		`Non-authoritative boundary padding: ${"archive-padding ".repeat(256)}`,
	];
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
	readonly summaryKeepRecentTokens: number;
}): Promise<AgentSession> {
	const hardCut = options.configuration.group === "C";
	const tools = ["read", "edit", "write", ...options.customTools.map((tool) => tool.name)];
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
			compaction: { enabled: true, keepRecentTokens: options.summaryKeepRecentTokens, reserveTokens: 4_000 },
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
	readonly configuration: RepositoryGroupConfiguration;
	readonly boundaryTrigger: BoundaryTrigger;
	readonly completedCostUsd: number;
	readonly maxCostUsd: number;
	readonly price: ModelPrice;
}): Promise<BoundaryEvidence> {
	const hardCut = options.configuration.group === "C";
	const before = options.session.getContextManagementTrace();
	if (!hardCut && !prepareCompaction(options.session.sessionManager.getBranch(), options.session.settingsManager.getCompactionSettings())) {
		return { boundary: options.boundary, requestedTrigger: "summary", actualReason: "retained", modelReply: "", newContextCalls: 0, postCutToolNames: [] };
	}
	const newContextCallsBefore = toolResultEntries(options.session.sessionManager.getBranch(), "new_context").length;
	let unsubscribe = () => {};
	if (hardCut && options.boundaryTrigger === "model") {
		let completed = false;
		unsubscribe = options.session.subscribe((event) => {
			if (completed || event.type !== "context_window_end" || event.reason !== "model") return;
			completed = true;
			options.session.setActiveToolsByName(
				options.session.getActiveToolNames().filter((name) => name !== "new_context"),
			);
		});
	}
	let modelReply = "";
	try {
		if (hardCut && options.boundaryTrigger === "model") {
			const reply = await executeRepositoryPhase(options.session, boundaryPrompt(options.boundary));
			ensureBudget(options.session, options.completedCostUsd, options.maxCostUsd, options.price);
			modelReply = reply.text;
		}
		if (!hardCut) {
			const compacted = await options.session.compactForCommand(compactionInstruction(options.boundary));
			if (compacted.strategy !== "summary") throw new Error(`Expected summary boundary, got ${compacted.strategy}`);
			ensureBudget(options.session, options.completedCostUsd, options.maxCostUsd, options.price);
		} else {
			const current = options.session.getContextManagementTrace();
			if (current.stats.hardCuts.count === before.stats.hardCuts.count) {
				const boundary = await options.session.requestContextWindow("manual");
				if (!boundary) throw new Error(`Runner could not create boundary ${options.boundary}`);
			}
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
	const branch = options.session.sessionManager.getBranch();
	const boundaryEntry = hardCut ? branch.filter((entry) => entry.type === "context_window").at(-1) : undefined;
	const boundaryIndex = boundaryEntry ? branch.findIndex(({ id }) => id === boundaryEntry.id) : -1;
	const postCutToolNames = branch
		.slice(boundaryIndex + 1)
		.flatMap((entry) =>
			boundaryIndex >= 0 && entry.type === "message" && entry.message.role === "toolResult"
				? [entry.message.toolName]
				: [],
		);
	return {
		boundary: options.boundary,
		requestedTrigger: hardCut ? options.boundaryTrigger : "summary",
		actualReason: boundaryEntry?.reason ?? "summary",
		...(boundaryEntry ? { boundaryEntryId: boundaryEntry.id } : {}),
		modelReply,
		newContextCalls:
			toolResultEntries(options.session.sessionManager.getBranch(), "new_context").length - newContextCallsBefore,
		postCutToolNames,
	};
}

async function reopenRepositorySession(options: {
	readonly session: AgentSession;
	readonly sessionsDirectory: string;
	readonly workspace: string;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly configuration: RepositoryGroupConfiguration;
	readonly boundaryTrigger: BoundaryTrigger;
	readonly customTools: CustomTools;
	readonly phase: 2 | 3 | 4;
	readonly summaryKeepRecentTokens: number;
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
		includeNewContext: options.boundaryTrigger === "model" && options.phase < 4,
		summaryKeepRecentTokens: options.summaryKeepRecentTokens,
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
	readonly boundaryTrigger: BoundaryTrigger;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly price: ModelPrice;
	readonly outputDirectory: string;
	readonly completedCostUsd: number;
	readonly maxCostUsd: number;
	readonly memoryPolicy: MemoryPolicy;
	readonly scenario: GovernanceScenario;
	readonly summaryKeepRecentTokens: number;
}): Promise<RealRepositoryRunResult> {
	const { task, configuration, modelRuntime, model, thinking, price, completedCostUsd, maxCostUsd } = options;
	const phasePrompts = repositoryPhasePrompts(task, options.memoryPolicy, options.scenario);
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
	let manager = SessionManager.create(fixture.workspace, sessionsDirectory);
	const customTools: CustomTools = [createEvidenceStatusTool(() => manager), createProbeTool(task, () => manager), createVerificationTool(runDirectory, task, verificationExecutions, () => manager)];
	if (options.scenario === "interrupted-operation") {
		writeFileSync(join(runDirectory, "operation-receipt.json"), JSON.stringify({ committed: false, commits: 0, applyAttempts: 0, inspections: 0 }));
		customTools.push(createOperationTool(runDirectory));
	}
	let session: AgentSession | undefined;
	const phaseReplies: string[] = [];
	const boundaryReplies: string[] = [];
	const boundaryEvidence: BoundaryEvidence[] = [];
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
			includeNewContext: options.boundaryTrigger === "model",
			summaryKeepRecentTokens: options.summaryKeepRecentTokens,
		});
		manager.appendCustomEntry("benchmark-phase", { phase: 1 });
		const inspection = await executeRepositoryPhase(session, phasePrompts[0]);
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		phaseReplies.push(inspection.text);
		probeEntryId = toolResultEntries(manager.getBranch(), "benchmark_probe").at(-1)?.id;
		boundaryEvidence.push(
			await createControlledBoundary({
				session,
				boundary: 1,
				configuration,
				boundaryTrigger: options.boundaryTrigger,
				completedCostUsd,
				maxCostUsd,
				price,
			}),
		);
		if (boundaryEvidence.at(-1)?.modelReply) boundaryReplies.push(boundaryEvidence.at(-1)?.modelReply ?? "");
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
			boundaryTrigger: options.boundaryTrigger,
			customTools,
			phase: 2,
			summaryKeepRecentTokens: options.summaryKeepRecentTokens,
		});
		session = reopened.session;
		manager = reopened.manager;
		resumeEvidence.push(reopened.evidence);
		manager.appendCustomEntry("benchmark-phase", { phase: 2 });
		const diagnosis = await executeRepositoryPhase(session, phasePrompts[1]);
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		phaseReplies.push(diagnosis.text);
		diagnosisEntryId = diagnosis.id;
		sourceUnchangedBeforeImplementation = sha256(readFileSync(fixture.sourcePath)) === fixture.initialSourceHash;
		boundaryEvidence.push(
			await createControlledBoundary({
				session,
				boundary: 2,
				configuration,
				boundaryTrigger: options.boundaryTrigger,
				completedCostUsd,
				maxCostUsd,
				price,
			}),
		);
		if (boundaryEvidence.at(-1)?.modelReply) boundaryReplies.push(boundaryEvidence.at(-1)?.modelReply ?? "");
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
			boundaryTrigger: options.boundaryTrigger,
			customTools,
			phase: 3,
			summaryKeepRecentTokens: options.summaryKeepRecentTokens,
		});
		session = reopened.session;
		manager = reopened.manager;
		resumeEvidence.push(reopened.evidence);
		manager.appendCustomEntry("benchmark-phase", { phase: 3 });
		const implementation = await executeRepositoryPhase(session, phasePrompts[2]);
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		phaseReplies.push(implementation.text);
		initialVerificationEntryId = toolResultEntries(manager.getBranch(), "benchmark_verify").at(-1)?.id;
		prematureMarker = readFileSync(fixture.sourcePath, "utf8").includes(task.probe.repairMarker);
		if (options.scenario !== "continuity") injectGovernanceIntervention(runDirectory, task, options.scenario);
		boundaryEvidence.push(
			await createControlledBoundary({
				session,
				boundary: 3,
				configuration,
				boundaryTrigger: options.boundaryTrigger,
				completedCostUsd,
				maxCostUsd,
				price,
			}),
		);
		if (boundaryEvidence.at(-1)?.modelReply) boundaryReplies.push(boundaryEvidence.at(-1)?.modelReply ?? "");
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
			boundaryTrigger: options.boundaryTrigger,
			customTools,
			phase: 4,
			summaryKeepRecentTokens: options.summaryKeepRecentTokens,
		});
		session = reopened.session;
		manager = reopened.manager;
		resumeEvidence.push(reopened.evidence);
		manager.appendCustomEntry("benchmark-phase", { phase: 4 });
		const delivery = await executeRepositoryPhase(session, phasePrompts[3]);
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		finalResponse = delivery.text;
		phaseReplies.push(finalResponse);
		independentVerification = runRepositoryFixtureVerification(runDirectory, task, "repair");
		verificationExecutions.push({ ...independentVerification, source: "runner" });
	} catch (caught) {
		error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
	}

	const branch = manager.getBranch();
	const trace = session?.getContextManagementTrace();
	const hardCut = configuration.group === "C";
	const requireEvidenceExclusion = hardCut || options.summaryKeepRecentTokens === 1;
	const boundaries = branch.filter((entry) => entry.type === "context_window");
	const noteEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === "memory-note");
	const modelVerifications = verificationExecutions.filter(({ source }) => source === "model");
	const initialVerification = modelVerifications.find(({ phase }) => phase === "initial");
	const repairVerification = modelVerifications.find(({ phase }) => phase === "repair");
	const finalSource = readFileSync(fixture.sourcePath, "utf8");
	const finalFiles = relativeWorkspaceFiles(fixture.workspace);
	const protectedStatus = protectedFilesUnchanged(fixture.workspace, fixture.protectedHashes);
	const modelTriggered = boundaryEvidence.filter(({ actualReason }) => actualReason === "model").length;
	const runnerTriggered = boundaryEvidence.filter(({ actualReason }) => actualReason === "manual").length;
	const newContextCalls = boundaryEvidence.reduce((sum, boundary) => sum + boundary.newContextCalls, 0);
	const postCutToolCalls = boundaryEvidence.reduce((sum, boundary) => sum + boundary.postCutToolNames.length, 0);
	const modelTriggerOpportunities = hardCut && options.boundaryTrigger === "model" ? 3 : 0;
	const probeCalls = toolResultEntries(branch, "benchmark_probe").length;
	const verificationCallPhases = branch.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
		? entry.message.content.flatMap((part) => part.type === "toolCall" && part.name === "benchmark_verify" ? [part.arguments.phase] : []) : []);
	const boundaryProtocol: BoundaryProtocolMetrics = {
		trigger: options.boundaryTrigger,
		opportunities: modelTriggerOpportunities,
		modelTriggered,
		runnerTriggered,
		modelTriggerMisses: Math.max(0, modelTriggerOpportunities - modelTriggered),
		newContextCalls,
		duplicateNewContextCalls: Math.max(0, newContextCalls - modelTriggered),
		postCutToolCalls,
		redundantProbeCalls: Math.max(0, probeCalls - 1),
	};
	const checks: RepositoryEvaluationCheck[] = [
		...evaluateRepositoryFinalResponse(finalResponse, options.scenario === "changed-requirement"
			? { ...task, expectedFinal: { ...task.expectedFinal, delivery_label: "approved" } } : task),
		check("marker-recovered-before-verification", repairVerification?.markerPresentBeforeCall === true, "exact marker was present before the first repair verification; repair never discloses it"),
		check("verification-matches-final-source", repairVerification?.passed === true && repairVerification.sourceHash === `sha256:${sha256(finalSource)}`, "successful model verification covers the final source hash"),
		check("probe-excluded-after-boundary", !requireEvidenceExclusion || probeExcludedAfterBoundary, `probe excluded=${probeExcludedAfterBoundary}; required=${requireEvidenceExclusion}`),
		check(
			"diagnosis-boundary-policy",
			diagnosisEntryId !== undefined && (hardCut ? diagnosisExcludedAfterBoundary : options.summaryKeepRecentTokens !== 1 || !diagnosisExcludedAfterBoundary),
			hardCut
				? "hard cut excluded the prior diagnosis reply"
				: `summary diagnosis excluded=${diagnosisExcludedAfterBoundary}; recent retention depends on configured budget`,
		),
		check("failure-excluded-after-boundary", !requireEvidenceExclusion || failureExcludedAfterBoundary, `failure excluded=${failureExcludedAfterBoundary}; required=${requireEvidenceExclusion}`),
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
	if (options.scenario === "stale-evidence") {
		const intervention: { beforeSourceHash: string; afterSourceHash: string } | undefined = existsSync(join(runDirectory, "intervention.json"))
			? JSON.parse(readFileSync(join(runDirectory, "intervention.json"), "utf8")) : undefined;
		checks.push(check("stale-verification-invalidated", intervention !== undefined &&
			intervention.beforeSourceHash === initialVerification?.sourceHash && intervention.beforeSourceHash !== intervention.afterSourceHash &&
			repairVerification?.passed === true && repairVerification.sourceHash === `sha256:${sha256(finalSource)}`,
			"external source mutation followed the initial verification; a successful new verification covers the final revision"));
	}
	if (options.scenario === "interrupted-operation") {
		const receipt: OperationReceipt = JSON.parse(readFileSync(join(runDirectory, "operation-receipt.json"), "utf8"));
		let lastBoundaryIndex = -1;
		for (const [index, entry] of branch.entries()) {
			if (entry.type === "custom" && entry.customType === "benchmark-phase" && isRecord(entry.data) && entry.data.phase === 4) lastBoundaryIndex = index;
		}
		checks.push(check("interrupted-operation-reconciled", receipt.committed && receipt.commits === 1 && receipt.applyAttempts === 0 &&
			toolResultEntries(branch.slice(lastBoundaryIndex + 1), "benchmark_operation").length > 0,
			`receipt inspected after resume; commits=${receipt.commits}; duplicate/early model apply attempts=${receipt.applyAttempts}`));
	}
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
				"three-boundary-opportunities",
				hardCut
					? trace.stats.hardCuts.count === 3 && trace.stats.summaries.count === 0
					: boundaryEvidence.length === 3 && trace.stats.summaries.count === boundaryEvidence.filter((item) => item.actualReason === "summary").length && trace.stats.hardCuts.count === 0,
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
				options.memoryPolicy === "autonomous" || (hardCut ? requiredHistorySearches : trace.stats.history.queryCount === 0),
				`History queries=${trace.stats.history.queryCount}; exact route required=${options.memoryPolicy === "scripted"}`,
			),
			check(
				"notes-route",
				options.memoryPolicy === "autonomous" || (hardCut ? trace.stats.notes.operationCount === 3 : trace.stats.notes.operationCount === 0),
				`Note operations=${trace.stats.notes.operationCount}; fixed count required=${options.memoryPolicy === "scripted"}`,
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
				options.memoryPolicy === "autonomous" || (!JSON.stringify(noteEntries).includes(task.probe.memoryToken) &&
					!JSON.stringify(noteEntries).includes(task.probe.repairMarker)),
				options.memoryPolicy === "autonomous" ? "autonomous Notes may retain exact evidence" : "Notes contain neither the first-window token nor the hidden repair marker",
			),
		);
	}
	const expectedBoundaryReason = hardCut ? (options.boundaryTrigger === "model" ? "model" : "manual") : "summary";
	const protocolChecks: RepositoryEvaluationCheck[] = [
		check("phase-one-reply", phaseReplies[0] === "PHASE_ONE_READY", `received ${JSON.stringify(phaseReplies[0])}`),
		check("phase-two-reply", phaseReplies[1] === "DIAGNOSIS_READY", `received ${JSON.stringify(phaseReplies[1])}`),
		check("phase-three-reply", phaseReplies[2] === "REPAIR_REQUIRED", `received ${JSON.stringify(phaseReplies[2])}`),
		check(
			"boundary-replies",
			hardCut && options.boundaryTrigger === "model"
				? boundaryReplies.length === 3 &&
					boundaryReplies.every((reply, index) => reply === `WINDOW_${index + 1}_READY`)
				: boundaryReplies.length === 0,
			`received ${JSON.stringify(boundaryReplies)}`,
		),
		check("probe-called-once", probeCalls === 1, `probe calls=${probeCalls}`),
		check("initial-verification-called-once", verificationCallPhases.filter((phase) => phase === "initial").length === 1, "exactly one initial verification attempt, including blocked attempts"),
		check(
			"repair-verification-passed",
			verificationCallPhases.filter((phase) => phase === "repair").length === 1 &&
				modelVerifications.filter(({ phase }) => phase === "repair").length === 1 && repairVerification?.passed === true,
			"one model-requested repair verification passed after applying the recovered marker",
		),
		check(
			"boundary-trigger-adherence",
			boundaryEvidence.length === 3 && boundaryEvidence.every(({ actualReason }) => actualReason === expectedBoundaryReason || (!hardCut && actualReason === "retained")),
			`expected ${expectedBoundaryReason}; received ${boundaryEvidence.map(({ actualReason }) => actualReason).join(", ")}`,
		),
		check(
			"new-context-call-count",
			newContextCalls === modelTriggerOpportunities,
			`new_context calls=${newContextCalls}; opportunities=${modelTriggerOpportunities}`,
		),
		check(
			"no-post-cut-tool-actions",
			postCutToolCalls === 0,
			`post-cut tools=${boundaryEvidence.flatMap(({ postCutToolNames }) => postCutToolNames).join(", ") || "none"}`,
		),
	];
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
		memoryPassed: error === undefined && checks.every(({ passed }) => passed),
		protocolPassed: error === undefined && protocolChecks.every(({ passed }) => passed),
		recoveryPassed: error === undefined && probeCalls === 1 && ["final-value:memory_token", "marker-recovered-before-verification", "verification-matches-final-source", "independent-verification-passed", "three-disk-resumes"].every((id) => checks.some((item) => item.id === id && item.passed)),
		evidenceExposure: { probeExcludedAfterBoundary, diagnosisExcludedAfterBoundary, failureExcludedAfterBoundary, crossBoundaryRecoveryExercised: probeExcludedAfterBoundary && failureExcludedAfterBoundary && resumeEvidence.length === 3 },
		checks,
		protocolChecks,
		metrics,
		boundaryProtocol,
		phaseReplies,
		boundaryReplies,
		boundaryEvidence,
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
		const boundary = result.boundaryProtocol;
		return `| ${result.repetition} | ${result.group} | ${result.taskId} | ${result.memoryPassed ? "PASS" : "FAIL"} | ${result.protocolPassed ? "PASS" : "FAIL"} | ${boundary.modelTriggered}/${boundary.runnerTriggered}/${boundary.modelTriggerMisses} | ${boundary.postCutToolCalls} | ${metrics.resumes} | ${metrics.hardCuts}/${metrics.summaries} | ${metrics.historyQueries}/${metrics.historyHits} | ${metrics.noteOperations} | ${metrics.snapshotReferences} | ${metrics.providerCalls} | ${metrics.tokens.input} | ${metrics.tokens.output} | $${metrics.estimatedCostUsd.toFixed(6)} | ${metrics.durationMs} |`;
	});
	return [
		"# Repeated Real-Repository Multi-Window Evaluation",
		"",
		`- Task Set: \`${report.taskSetId}\``,
		`- Model: \`${report.configuration.provider}/${report.configuration.model}\``,
		`- Thinking: \`${report.configuration.thinking}\``,
		`- Hard-cut boundary trigger: \`${report.configuration.boundaryTrigger}\``,
		`- Phase Prompt protocol: \`${report.configuration.phasePromptProtocol}\``,
		`- Evaluation kind: \`${report.configuration.evaluationKind}\`; memory policy: ${report.configuration.memoryPolicy}; scenario: ${report.configuration.scenario}`,
		"- Boundaries and task phases remain controller-driven; autonomous policy only removes prescribed memory operations.",
		`- Summary recent-token target: ${report.configuration.summaryKeepRecentTokens}; 20000 is the ordinary retention target, while phases remain controlled.`,
		`- Trials with both original evidence entries excluded across boundaries: ${report.results.filter((result) => result.evidenceExposure.crossBoundaryRecoveryExercised).length}/${report.totalRuns}`,
		`- Phase Prompt hashes: ${Object.entries(report.configuration.phasePromptHashes)
			.map(([taskId, hash]) => `\`${taskId}=${hash}\``)
			.join(", ")}`,
		"- Execution: strictly serial",
		`- Composite memory/task/mechanism result: ${report.passedRuns}/${report.totalRuns} passed${report.aborted ? " (aborted)" : ""}`,
		`- Protocol result: ${report.protocolPassedRuns}/${report.totalRuns} passed`,
		`- Recovery result: ${report.results.filter(({ recoveryPassed }) => recoveryPassed).length}/${report.totalRuns} passed`,
		`- Estimated cost: $${report.estimatedCostUsd.toFixed(6)} / $${report.configuration.maxCostUsd.toFixed(2)}`,
		`- Pricing: [OpenAI API pricing](${report.configuration.pricingSource})`,
		"",
		"| Repeat | Group | Task | Memory | Protocol | Model/runner/miss | Post-cut tools | Resumes | Hard/Summary | History q/h | Notes | Snapshots | Calls | Input | Output | Cost | ms |",
		"|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
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
		`${JSON.stringify({ schemaVersion: 2, taskSetId, serialExecution: true, configuration, results }, null, 2)}\n`,
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
		boundaryTrigger: options.boundaryTrigger,
		phasePromptProtocol: options.memoryPolicy === "scripted" ? "matched-v5" : "autonomous-v3",
		evaluationKind: options.memoryPolicy === "scripted" ? "controlled-memory-stress" : "controlled-autonomous-memory",
		memoryPolicy: options.memoryPolicy,
		scenario: options.scenario,
		summaryKeepRecentTokens: options.summaryKeepRecentTokens,
		phasePromptHashes: Object.fromEntries(tasks.map((task) => [task.id, repositoryPhasePromptHash(task, options.memoryPolicy, options.scenario)])),
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
					boundaryTrigger: options.boundaryTrigger,
					memoryPolicy: options.memoryPolicy,
					scenario: options.scenario,
					summaryKeepRecentTokens: options.summaryKeepRecentTokens,
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
					`[memory=${result.memoryPassed ? "PASS" : "FAIL"} protocol=${result.protocolPassed ? "PASS" : "FAIL"}] repeat ${repetition} / ${group.group} / ${task.id} / $${result.metrics.estimatedCostUsd.toFixed(6)} / cumulative $${completedCostUsd.toFixed(6)}`,
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
	const protocolPassedRuns = results.filter(({ protocolPassed }) => protocolPassed).length;
	const report: RealRepositoryReport = {
		schemaVersion: 2,
		taskSetId: taskSet.id,
		deterministicGrading: true,
		serialExecution: true,
		startedAt,
		completedAt: new Date().toISOString(),
		aborted,
		configuration,
		passedRuns,
		protocolPassedRuns,
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
