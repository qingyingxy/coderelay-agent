/**
 * Serial real-model coding evaluation across two context boundaries and two
 * disk-backed AgentSession resumes.
 *
 * This runner makes paid network requests. It executes one model interaction
 * at a time, uses a fresh fixture workspace per run, and writes checkpoints
 * after every strategy group.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
const DEFAULT_TASK_SET_PATH = join(SCRIPT_DIR, "real-coding-task-set.json");
const DEFAULT_MAX_COST_USD = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 3_000;
const EVALUATION_CONTEXT_WINDOW = 272_000;
const PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const ALLOWED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type AllowedThinkingLevel = (typeof ALLOWED_THINKING_LEVELS)[number];
type JsonPrimitive = string | number | boolean | null;
type CodingGroup = "A" | "C";
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

interface CodingGroupConfiguration {
	readonly group: CodingGroup;
	readonly strategy: string;
	readonly mode: ContextManagementMode;
	readonly workflow: boolean;
}

const GROUP_CONFIGURATIONS: readonly CodingGroupConfiguration[] = [
	{ group: "A", strategy: "summary", mode: "summary", workflow: false },
	{
		group: "C",
		strategy: "windowed + Workflow Snapshot + Notes + History",
		mode: "windowed",
		workflow: true,
	},
];

export interface RealCodingTask {
	readonly id: string;
	readonly description: string;
	readonly durableFacts: readonly string[];
	readonly probe: {
		readonly probeId: string;
		readonly repairMarker: string;
	};
	readonly expectedFinal: Readonly<Record<string, JsonPrimitive>>;
}

export interface RealCodingTaskSet {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly tasks: readonly RealCodingTask[];
}

export interface RealCodingCliOptions {
	readonly provider?: string;
	readonly model?: string;
	readonly thinking: AllowedThinkingLevel;
	readonly taskSetPath: string;
	readonly outputDirectory: string;
	readonly maxCostUsd: number;
	readonly maxOutputTokens: number;
	readonly verifyTaskSet: boolean;
}

export interface CodingEvaluationCheck {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

export interface FixtureVerificationResult {
	readonly phase: "initial" | "repair";
	readonly passed: boolean;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

interface EvaluationTokens {
	readonly input: number;
	readonly output: number;
	readonly reasoning: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

interface CodingRunMetrics {
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

interface VerificationExecution extends FixtureVerificationResult {
	readonly source: "model" | "runner";
}

interface ResumeEvidence {
	readonly phase: 2 | 3;
	readonly sameSessionFile: boolean;
	readonly activeContextRestored: boolean;
	readonly branchEntries: number;
}

interface RealCodingRunResult {
	readonly taskId: string;
	readonly group: CodingGroup;
	readonly strategy: string;
	readonly passed: boolean;
	readonly checks: readonly CodingEvaluationCheck[];
	readonly metrics: CodingRunMetrics;
	readonly phaseReplies: readonly string[];
	readonly verificationExecutions: readonly VerificationExecution[];
	readonly resumeEvidence: readonly ResumeEvidence[];
	readonly finalResponse: string;
	readonly sessionFile?: string;
	readonly traceFile?: string;
	readonly error?: string;
}

interface RealCodingReport {
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
		readonly pricingPerMillionTokens: ModelPrice;
		readonly pricingSource: string;
	};
	readonly passedRuns: number;
	readonly totalRuns: number;
	readonly plannedRuns: number;
	readonly estimatedCostUsd: number;
	readonly results: readonly RealCodingRunResult[];
}

interface FixtureFiles {
	readonly sourcePath: string;
	readonly specPath: string;
	readonly packagePath: string;
	readonly verifierPath: string;
	readonly initialSourceHash: string;
	readonly specHash: string;
	readonly packageHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function parseStringArray(value: unknown, path: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		throw new Error(`${path} must be an array of non-empty strings`);
	}
	return value;
}

function parsePrimitiveRecord(value: unknown, path: string): Readonly<Record<string, JsonPrimitive>> {
	if (!isRecord(value) || Object.keys(value).length === 0) throw new Error(`${path} must be a non-empty object`);
	for (const [key, item] of Object.entries(value)) {
		if (!key || (!['string', 'number', 'boolean'].includes(typeof item) && item !== null)) {
			throw new Error(`${path}.${key} must be a JSON primitive`);
		}
	}
	return value as Readonly<Record<string, JsonPrimitive>>;
}

export function parseRealCodingTaskSet(value: unknown): RealCodingTaskSet {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Task Set schemaVersion must be 1");
	const id = parseNonEmptyString(value.id, "Task Set id");
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error("Task Set tasks must be non-empty");
	const ids = new Set<string>();
	const tasks = value.tasks.map((candidate, index): RealCodingTask => {
		const path = `tasks[${index}]`;
		if (!isRecord(candidate) || !isRecord(candidate.probe)) throw new Error(`${path} must contain a probe`);
		const taskId = parseNonEmptyString(candidate.id, `${path}.id`);
		if (ids.has(taskId)) throw new Error(`Duplicate task id: ${taskId}`);
		ids.add(taskId);
		const expectedFinal = parsePrimitiveRecord(candidate.expectedFinal, `${path}.expectedFinal`);
		if (expectedFinal.case_id !== taskId) throw new Error(`${path}.expectedFinal.case_id must equal ${taskId}`);
		return {
			id: taskId,
			description: parseNonEmptyString(candidate.description, `${path}.description`),
			durableFacts: parseStringArray(candidate.durableFacts, `${path}.durableFacts`),
			probe: {
				probeId: parseNonEmptyString(candidate.probe.probeId, `${path}.probe.probeId`),
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

function nextArgument(args: readonly string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function defaultOutputDirectory(): string {
	const suffix = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	return resolve(".artifacts", `context-window-real-coding-${suffix}`);
}

export function parseRealCodingCliOptions(args: readonly string[]): RealCodingCliOptions {
	let provider: string | undefined;
	let model: string | undefined;
	let thinking: AllowedThinkingLevel = "medium";
	let taskSetPath = DEFAULT_TASK_SET_PATH;
	let outputDirectory = defaultOutputDirectory();
	let maxCostUsd = DEFAULT_MAX_COST_USD;
	let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
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
			case "--max-output-tokens": {
				const parsed = parsePositiveNumber(value, argument);
				if (!Number.isSafeInteger(parsed)) throw new Error(`${argument} requires a positive integer`);
				maxOutputTokens = parsed;
				break;
			}
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}
	return { provider, model, thinking, taskSetPath, outputDirectory, maxCostUsd, maxOutputTokens, verifyTaskSet };
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function fixtureSpec(task: RealCodingTask): string {
	return [
		"# Deployment Router",
		"",
		"Only edit `src/router.mjs`.",
		"",
		"Export `resolveDeployment(records, requestedService)` with these rules:",
		"",
		"1. Compare `requestedService` with each record's `service` after trimming and lowercasing both values.",
		"2. Ignore records whose `enabled` field is not exactly `true`.",
		"3. Select the enabled match with the highest integer `revision`.",
		"4. When revisions tie, the later array item wins.",
		"5. Return a new object containing only `route`, `owner`, and `revision`.",
		"6. When no enabled record matches, return `{ route: \"route:fallback\", owner: \"team-ember\", revision: 0 }`.",
		"7. Do not mutate the input array or its records.",
		"",
		"A later hidden verification may require one additional named export. Do not guess it before the verifier reports the exact contract.",
		"",
		`Evaluation case: ${task.id}`,
	].join("\n");
}

function initialFixtureSource(): string {
	return [
		"export function resolveDeployment(_records, _requestedService) {",
		'\tthrow new Error("not implemented");',
		"}",
		"",
	].join("\n");
}

function hiddenVerifierSource(task: RealCodingTask): string {
	return `import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const phase = process.argv[2];
if (phase !== "initial" && phase !== "repair") throw new Error("phase must be initial or repair");
const subject = await import(pathToFileURL(resolve("src/router.mjs")).href);
assert.equal(typeof subject.resolveDeployment, "function", "resolveDeployment must be exported");

const records = [
	{ service: " API ", enabled: true, revision: 2, route: "route:v2", owner: "team-slate" },
	{ service: "api", enabled: false, revision: 99, route: "route:disabled", owner: "team-red" },
	{ service: "api", enabled: true, revision: 2, route: "route:v2-late", owner: "team-cyan" },
	{ service: "api", enabled: true, revision: 1, route: "route:v1", owner: "team-old" },
];
const before = JSON.stringify(records);
assert.deepEqual(subject.resolveDeployment(records, "  aPi "), {
	route: "route:v2-late",
	owner: "team-cyan",
	revision: 2,
});
assert.equal(JSON.stringify(records), before, "resolveDeployment must not mutate records");
assert.deepEqual(subject.resolveDeployment(records, "missing"), {
	route: "route:fallback",
	owner: "team-ember",
	revision: 0,
});
assert.deepEqual(subject.resolveDeployment([], "api"), {
	route: "route:fallback",
	owner: "team-ember",
	revision: 0,
});

const expectedMarker = ${JSON.stringify(task.probe.repairMarker)};
if (subject.repairMarker !== expectedMarker) {
	throw new Error(
		\`HIDDEN_REPAIR_REQUIRED: export const repairMarker must equal \${JSON.stringify(expectedMarker)}; received \${JSON.stringify(subject.repairMarker)}\`,
	);
}
console.log(\`verification:\${phase}:passed; marker=\${subject.repairMarker}\`);
`;
}

export function initializeCodingFixture(root: string, task: RealCodingTask): FixtureFiles {
	const sourcePath = join(root, "workspace", "src", "router.mjs");
	const specPath = join(root, "workspace", "SPEC.md");
	const packagePath = join(root, "workspace", "package.json");
	const verifierPath = join(root, "hidden", "verify.mjs");
	mkdirSync(dirname(sourcePath), { recursive: true });
	mkdirSync(dirname(verifierPath), { recursive: true });
	const source = initialFixtureSource();
	const spec = fixtureSpec(task);
	const packageJson = `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`;
	writeFileSync(sourcePath, source, "utf8");
	writeFileSync(specPath, spec, "utf8");
	writeFileSync(packagePath, packageJson, "utf8");
	writeFileSync(verifierPath, hiddenVerifierSource(task), "utf8");
	return {
		sourcePath,
		specPath,
		packagePath,
		verifierPath,
		initialSourceHash: sha256(source),
		specHash: sha256(spec),
		packageHash: sha256(packageJson),
	};
}

export function runCodingFixtureVerification(
	root: string,
	phase: "initial" | "repair",
): FixtureVerificationResult {
	const verifierPath = join(root, "hidden", "verify.mjs");
	const result = spawnSync(process.execPath, [verifierPath, phase], {
		cwd: join(root, "workspace"),
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
	const stderr = [result.error?.message, result.stderr].filter(Boolean).join("\n").trim();
	return {
		phase,
		passed: result.status === 0,
		exitCode: result.status,
		stdout: result.stdout.trim(),
		stderr,
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
			"Run the controlled multi-window coding evaluation. Work only in the fixture workspace, follow each phase literally, and use the requested tools exactly. Do not inspect parent directories or hidden evaluator files.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function createProbeTool(task: RealCodingTask) {
	return defineTool({
		name: "benchmark_probe",
		label: "Benchmark probe",
		description: `Read the immutable hidden contract probe ${task.probe.probeId}.`,
		promptSnippet: "Read one immutable benchmark probe by probe_id",
		parameters: Type.Object({ probe_id: Type.Literal(task.probe.probeId) }),
		executionMode: "sequential",
		execute: async () => {
			const details = { probe_id: task.probe.probeId, repair_marker: task.probe.repairMarker };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}

function createVerificationTool(
	root: string,
	executions: VerificationExecution[],
) {
	return defineTool({
		name: "benchmark_verify",
		label: "Benchmark verify",
		description: "Run the isolated deterministic verifier for the requested coding phase.",
		promptSnippet: "Run the controlled coding verifier with phase initial or repair",
		parameters: Type.Object({ phase: Type.Union([Type.Literal("initial"), Type.Literal("repair")]) }),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const result = runCodingFixtureVerification(root, params.phase);
			executions.push({ ...result, source: "model" });
			if (!result.passed) {
				throw new Error([result.stderr, result.stdout].filter(Boolean).join("\n"));
			}
			return {
				content: [{ type: "text" as const, text: result.stdout }],
				details: result,
			};
		},
	});
}

function lastAssistantText(branch: readonly SessionEntry[]): string {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function toolResultEntries(
	branch: readonly SessionEntry[],
	toolName: string,
): Array<Extract<SessionEntry, { type: "message" }>> {
	const entries: Array<Extract<SessionEntry, { type: "message" }>> = [];
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === toolName) {
			entries.push(entry);
		}
	}
	return entries;
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

function collectMetrics(session: AgentSession, price: ModelPrice, startedAt: number, resumes: number): CodingRunMetrics {
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

function emptyMetrics(startedAt: number, resumes: number): CodingRunMetrics {
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

function phaseOnePrompt(task: RealCodingTask, hardCut: boolean): string {
	const noteArguments = {
		action: "upsert",
		note_id: `${task.id}-spec`,
		category: "constraint",
		content: task.durableFacts.join(" "),
		source_entry_ids: [],
	};
	return [
		"Phase 1: inspect the coding task without modifying files.",
		`External case_id: ${task.id}`,
		"Read SPEC.md and src/router.mjs.",
		...(hardCut
			? [
					"Call notes exactly once with these arguments:",
					JSON.stringify(noteArguments),
					"Do not put benchmark probe output into Notes.",
				]
			: []),
		`Call benchmark_probe exactly once with {"probe_id":${JSON.stringify(task.probe.probeId)}}.`,
		"Do not edit files, quote the probe result, or add an extra visible explanation.",
		"Reply exactly PHASE_ONE_READY.",
	].join("\n");
}

function boundaryPrompt(boundary: 1 | 2, hardCut: boolean, task: RealCodingTask): string {
	const lines = [
		`Controlled boundary ${boundary}. Do not inspect or edit files in this turn.`,
		`Non-authoritative boundary padding: ${"archive-padding ".repeat(256)}`,
	];
	if (!hardCut) {
		return [...lines, `Reply exactly WINDOW_${boundary}_READY without calling a tool.`].join("\n");
	}
	if (boundary === 2) {
		lines.push(
			"Call notes exactly once with these arguments:",
			JSON.stringify({
				action: "upsert",
				note_id: `${task.id}-repair-state`,
				category: "open_question",
				content: "Base implementation was attempted and hidden verification failed. Use History after the next context boundary before repairing.",
				source_entry_ids: [],
			}),
			"Do not include the exact verifier failure or repair marker in Notes.",
		);
	}
	lines.push(
		"Call new_context exactly once with an empty object and do not call any other tool afterward.",
		`When new_context is no longer available in the fresh window, reply exactly WINDOW_${boundary}_READY.`,
	);
	return lines.join("\n");
}

function phaseTwoPrompt(task: RealCodingTask): string {
	return [
		"Phase 2: implement the documented resolver in src/router.mjs.",
		`External case_id: ${task.id}`,
		"Read SPEC.md and src/router.mjs, then edit only src/router.mjs.",
		"Implement only the documented contract. Do not guess or add repairMarker before verification reports it.",
		'After editing, call benchmark_verify exactly once with {"phase":"initial"}.',
		"If verification fails, do not repair or retry in this phase. Reply exactly REPAIR_REQUIRED.",
	].join("\n");
}

function phaseThreePrompt(task: RealCodingTask, hardCut: boolean): string {
	const historyArguments = {
		action: "search",
		query: "HIDDEN_REPAIR_REQUIRED",
		role: "toolResult",
		tool: "benchmark_verify",
		window_id: null,
		entry_ids: null,
		cursor: null,
		limit: 10,
	};
	return [
		"Phase 3: repair the implementation after the second context boundary.",
		`External case_id: ${task.id}`,
		...(hardCut
			? [
					"Call history exactly once with these arguments:",
					JSON.stringify(historyArguments),
					"Use the matching old benchmark_verify excerpt to recover the exact hidden repair contract.",
				]
			: ["Use the compacted summary to recover the exact hidden verification failure."]),
		"Read src/router.mjs, apply the smallest repair, and edit only that file.",
		'Call benchmark_verify exactly once with {"phase":"repair"}.',
		`After it passes, return exactly ${JSON.stringify(task.expectedFinal)} with no Markdown or explanation.`,
	].join("\n");
}

function check(id: string, passed: boolean, detail: string): CodingEvaluationCheck {
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

export function evaluateCodingFinalResponse(text: string, task: RealCodingTask): readonly CodingEvaluationCheck[] {
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

function listWorkspaceFiles(root: string, current = root): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const path = join(current, entry.name);
		if (entry.isDirectory()) files.push(...listWorkspaceFiles(root, path));
		else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
	}
	return files.sort();
}

async function createCodingSession(options: {
	readonly workspace: string;
	readonly sessionManager: SessionManager;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly configuration: CodingGroupConfiguration;
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
			retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120_000 } },
		}),
	});
	if (options.configuration.workflow) created.session.enableWorkflowTracking("direct");
	return created.session;
}

async function createControlledBoundary(options: {
	readonly session: AgentSession;
	readonly boundary: 1 | 2;
	readonly task: RealCodingTask;
	readonly configuration: CodingGroupConfiguration;
	readonly completedCostUsd: number;
	readonly maxCostUsd: number;
	readonly price: ModelPrice;
}): Promise<void> {
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
			const compacted = await options.session.compactForCommand(
				options.boundary === 1
					? "Preserve the coding specification and exact benchmark_probe output for later hidden verification."
					: "Preserve the exact failed benchmark_verify output and pending repair action.",
			);
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
}

async function reopenCodingSession(options: {
	readonly session: AgentSession;
	readonly sessionsDirectory: string;
	readonly workspace: string;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly configuration: CodingGroupConfiguration;
	readonly customTools: CustomTools;
	readonly phase: 2 | 3;
}): Promise<{ session: AgentSession; manager: SessionManager; evidence: ResumeEvidence }> {
	const sessionFile = options.session.sessionFile;
	if (!sessionFile || !existsSync(sessionFile)) throw new Error("Session JSONL is unavailable before resume");
	const activeBefore = JSON.stringify(options.session.messages);
	options.session.dispose();
	const manager = SessionManager.open(sessionFile, options.sessionsDirectory);
	const session = await createCodingSession({
		workspace: options.workspace,
		sessionManager: manager,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinking: options.thinking,
		configuration: options.configuration,
		customTools: options.customTools,
		includeNewContext: options.phase === 2,
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

async function runCodingCase(options: {
	readonly task: RealCodingTask;
	readonly configuration: CodingGroupConfiguration;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly price: ModelPrice;
	readonly outputDirectory: string;
	readonly completedCostUsd: number;
	readonly maxCostUsd: number;
}): Promise<RealCodingRunResult> {
	const { task, configuration, modelRuntime, model, thinking, price, completedCostUsd, maxCostUsd } = options;
	const startedAt = Date.now();
	const runDirectory = join(options.outputDirectory, `${task.id}-${configuration.group}`);
	const workspace = join(runDirectory, "workspace");
	const sessionsDirectory = join(runDirectory, "sessions");
	mkdirSync(sessionsDirectory, { recursive: true });
	const fixture = initializeCodingFixture(runDirectory, task);
	const verificationExecutions: VerificationExecution[] = [];
	const customTools: CustomTools = [
		createProbeTool(task),
		createVerificationTool(runDirectory, verificationExecutions),
	];
	let manager = SessionManager.create(workspace, sessionsDirectory);
	let session: AgentSession | undefined;
	const phaseReplies: string[] = [];
	const resumeEvidence: ResumeEvidence[] = [];
	let probeEntryId: string | undefined;
	let initialVerificationEntryId: string | undefined;
	let probeExcludedAfterBoundary = false;
	let failureExcludedAfterBoundary = false;
	let prematureRepair = false;
	let finalResponse = "";
	let independentVerification: FixtureVerificationResult | undefined;
	let error: string | undefined;
	try {
		session = await createCodingSession({
			workspace,
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
		phaseReplies.push(lastAssistantText(manager.getBranch()));
		probeEntryId = toolResultEntries(manager.getBranch(), "benchmark_probe").at(-1)?.id;
		await createControlledBoundary({
			session,
			boundary: 1,
			task,
			configuration,
			completedCostUsd,
			maxCostUsd,
			price,
		});
		phaseReplies.push(lastAssistantText(manager.getBranch()));
		probeExcludedAfterBoundary =
			probeEntryId !== undefined && !manager.buildContextEntries().some(({ id }) => id === probeEntryId);

		const resumedTwo = await reopenCodingSession({
			session,
			sessionsDirectory,
			workspace,
			modelRuntime,
			model,
			thinking,
			configuration,
			customTools,
			phase: 2,
		});
		session = resumedTwo.session;
		manager = resumedTwo.manager;
		resumeEvidence.push(resumedTwo.evidence);
		await session.prompt(phaseTwoPrompt(task));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		phaseReplies.push(lastAssistantText(manager.getBranch()));
		initialVerificationEntryId = toolResultEntries(manager.getBranch(), "benchmark_verify").at(-1)?.id;
		prematureRepair = readFileSync(fixture.sourcePath, "utf8").includes(task.probe.repairMarker);

		await createControlledBoundary({
			session,
			boundary: 2,
			task,
			configuration,
			completedCostUsd,
			maxCostUsd,
			price,
		});
		phaseReplies.push(lastAssistantText(manager.getBranch()));
		failureExcludedAfterBoundary =
			initialVerificationEntryId !== undefined &&
			!manager.buildContextEntries().some(({ id }) => id === initialVerificationEntryId);

		const resumedThree = await reopenCodingSession({
			session,
			sessionsDirectory,
			workspace,
			modelRuntime,
			model,
			thinking,
			configuration,
			customTools,
			phase: 3,
		});
		session = resumedThree.session;
		manager = resumedThree.manager;
		resumeEvidence.push(resumedThree.evidence);
		await session.prompt(phaseThreePrompt(task, configuration.group === "C"));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		finalResponse = lastAssistantText(manager.getBranch());
		phaseReplies.push(finalResponse);
		independentVerification = runCodingFixtureVerification(runDirectory, "repair");
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
	const finalFiles = listWorkspaceFiles(workspace);
	const checks: CodingEvaluationCheck[] = [
		...evaluateCodingFinalResponse(finalResponse, task),
		check("phase-one-reply", phaseReplies[0] === "PHASE_ONE_READY", `received ${JSON.stringify(phaseReplies[0])}`),
		check("probe-called-once", toolResultEntries(branch, "benchmark_probe").length === 1, "one probe result exists"),
		check("probe-excluded-after-boundary", probeExcludedAfterBoundary, "original probe result left active context"),
		check(
			"initial-verification-failed",
			modelVerifications.filter(({ phase }) => phase === "initial").length === 1 && initialVerification?.passed === false,
			"one initial verifier call produced the controlled hidden failure",
		),
		check("repair-not-premature", !prematureRepair, "repair marker was absent before the second boundary"),
		check(
			"failure-excluded-after-boundary",
			failureExcludedAfterBoundary,
			"original failed verifier result left active context",
		),
		check(
			"repair-verification-passed",
			modelVerifications.filter(({ phase }) => phase === "repair").length === 1 && repairVerification?.passed === true,
			"one model-requested repair verification passed",
		),
		check(
			"independent-verification-passed",
			independentVerification?.passed === true,
			"runner independently re-ran the hidden verifier",
		),
		check("source-changed", sha256(finalSource) !== fixture.initialSourceHash, "src/router.mjs changed from the stub"),
		check("spec-protected", sha256(readFileSync(fixture.specPath, "utf8")) === fixture.specHash, "SPEC.md unchanged"),
		check(
			"package-protected",
			sha256(readFileSync(fixture.packagePath, "utf8")) === fixture.packageHash,
			"package.json unchanged",
		),
		check(
			"workspace-files-isolated",
			JSON.stringify(finalFiles) === JSON.stringify(["SPEC.md", "package.json", "src/router.mjs"]),
			`workspace files: ${finalFiles.join(", ")}`,
		),
		check(
			"two-disk-resumes",
			resumeEvidence.length === 2 &&
				resumeEvidence.every(({ sameSessionFile, activeContextRestored }) => sameSessionFile && activeContextRestored),
			"both AgentSession recreations restored the same JSONL context",
		),
	];
	if (trace) {
		checks.push(
			check(
				"two-boundaries",
				hardCut
					? trace.stats.hardCuts.count === 2 && trace.stats.summaries.count === 0
					: trace.stats.summaries.count === 2 && trace.stats.hardCuts.count === 0,
				`hard cuts=${trace.stats.hardCuts.count}; summaries=${trace.stats.summaries.count}`,
			),
			check(
				"window-lineage",
				!hardCut ||
					(boundaries.length === 2 &&
						boundaries[0]?.windowIndex === 1 &&
						boundaries[1]?.windowIndex === 2 &&
						boundaries[1]?.firstWindowId === boundaries[0]?.firstWindowId &&
						boundaries[1]?.previousWindowId === boundaries[0]?.windowId),
				hardCut ? "two hard windows form one persisted lineage" : "summary baseline has no hard-window lineage",
			),
			check(
				"history-route",
				hardCut
					? trace.stats.history.queryCount >= 1 && trace.historyQueries.some(({ resultCount }) => resultCount >= 1)
					: trace.stats.history.queryCount === 0,
				`History queries=${trace.stats.history.queryCount}`,
			),
			check(
				"notes-route",
				hardCut ? trace.stats.notes.operationCount >= 2 : trace.stats.notes.operationCount === 0,
				`Note operations=${trace.stats.notes.operationCount}`,
			),
			check(
				"snapshot-route",
				hardCut
					? trace.windows.filter(({ snapshotEntryId }) => snapshotEntryId !== undefined).length === 2
					: trace.windows.length === 0,
				`Snapshot references=${trace.windows.filter(({ snapshotEntryId }) => snapshotEntryId !== undefined).length}`,
			),
			check(
				"notes-exclude-secret",
				!JSON.stringify(noteEntries).includes(task.probe.repairMarker),
				"Notes do not contain the hidden repair marker",
			),
		);
	}
	const metrics = session ? collectMetrics(session, price, startedAt, resumeEvidence.length) : emptyMetrics(startedAt, resumeEvidence.length);
	const traceFile = trace ? join(runDirectory, "context-management-trace.json") : undefined;
	if (traceFile && trace) writeFileSync(traceFile, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
	writeFileSync(join(runDirectory, "final-source.mjs"), finalSource, "utf8");
	writeFileSync(join(runDirectory, "final-response.txt"), `${finalResponse}\n`, "utf8");
	writeFileSync(join(runDirectory, "resume-evidence.json"), `${JSON.stringify(resumeEvidence, null, 2)}\n`, "utf8");
	const result: RealCodingRunResult = {
		taskId: task.id,
		group: configuration.group,
		strategy: configuration.strategy,
		passed: error === undefined && checks.every(({ passed }) => passed),
		checks,
		metrics,
		phaseReplies,
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

function markdownReport(report: RealCodingReport): string {
	const rows = report.results.map((result) => {
		const metrics = result.metrics;
		return `| ${result.group} | ${result.taskId} | ${result.passed ? "PASS" : "FAIL"} | ${metrics.resumes} | ${metrics.hardCuts}/${metrics.summaries} | ${metrics.historyQueries}/${metrics.historyHits} | ${metrics.noteOperations} | ${metrics.snapshotReferences} | ${metrics.providerCalls} | ${metrics.tokens.input} | ${metrics.tokens.output} | $${metrics.estimatedCostUsd.toFixed(6)} | ${metrics.durationMs} |`;
	});
	return [
		"# Real Multi-Window Coding Evaluation",
		"",
		`- Task Set: \`${report.taskSetId}\``,
		`- Model: \`${report.configuration.provider}/${report.configuration.model}\``,
		`- Thinking: \`${report.configuration.thinking}\``,
		"- Execution: strictly serial",
		`- Result: ${report.passedRuns}/${report.totalRuns} passed${report.aborted ? " (aborted)" : ""}`,
		`- Estimated cost: $${report.estimatedCostUsd.toFixed(6)} / $${report.configuration.maxCostUsd.toFixed(2)}`,
		`- Pricing: [OpenAI API pricing](${report.configuration.pricingSource})`,
		"",
		"| Group | Task | Result | Resumes | Hard/Summary | History q/h | Notes | Snapshots | Calls | Input | Output | Cost | ms |",
		"|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
		...rows,
		"",
	].join("\n");
}

function writeCheckpoint(
	path: string,
	configuration: RealCodingReport["configuration"],
	taskSetId: string,
	results: readonly RealCodingRunResult[],
): void {
	writeFileSync(
		path,
		`${JSON.stringify({ schemaVersion: 1, taskSetId, serialExecution: true, configuration, results }, null, 2)}\n`,
		"utf8",
	);
}

async function runRealCodingEvaluation(
	options: RealCodingCliOptions,
	taskSet: RealCodingTaskSet,
): Promise<RealCodingReport> {
	const settings = SettingsManager.create(process.cwd());
	const provider = options.provider ?? settings.getDefaultProvider();
	const requestedModel = options.model ?? settings.getDefaultModel();
	if (!provider || !requestedModel) {
		throw new Error("Real coding evaluation requires --provider and --model, or active Pi provider/model settings");
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
	const configuration: RealCodingReport["configuration"] = {
		provider,
		model: model.id,
		thinking: options.thinking,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		maxCostUsd: options.maxCostUsd,
		pricingPerMillionTokens: price,
		pricingSource: PRICING_SOURCE,
	};
	if (existsSync(join(options.outputDirectory, "report.json"))) {
		throw new Error(`Output directory already contains a report: ${options.outputDirectory}`);
	}
	mkdirSync(options.outputDirectory, { recursive: true });
	const startedAt = new Date().toISOString();
	const results: RealCodingRunResult[] = [];
	let completedCostUsd = 0;
	let aborted = false;
	const checkpointPath = join(options.outputDirectory, "checkpoint.json");
	for (const task of taskSet.tasks) {
		for (const group of GROUP_CONFIGURATIONS) {
			if (completedCostUsd >= options.maxCostUsd) {
				aborted = true;
				break;
			}
			console.log(`[RUN] ${group.group} / ${task.id} / serial`);
			const result = await runCodingCase({
				task,
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
				`[${result.passed ? "PASS" : "FAIL"}] ${group.group} / ${task.id} / $${result.metrics.estimatedCostUsd.toFixed(6)} / cumulative $${completedCostUsd.toFixed(6)}`,
			);
			if (result.error) {
				aborted = true;
				break;
			}
		}
		if (aborted) break;
	}
	const passedRuns = results.filter(({ passed }) => passed).length;
	const report: RealCodingReport = {
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
		plannedRuns: taskSet.tasks.length * GROUP_CONFIGURATIONS.length,
		estimatedCostUsd: completedCostUsd,
		results,
	};
	writeFileSync(join(options.outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	writeFileSync(join(options.outputDirectory, "report.md"), markdownReport(report), "utf8");
	return report;
}

const isMain = process.argv[1]?.endsWith("evaluate-real-coding.ts") ?? false;
if (isMain) {
	const options = parseRealCodingCliOptions(process.argv.slice(2));
	const taskSet = parseRealCodingTaskSet(JSON.parse(readFileSync(options.taskSetPath, "utf8")));
	if (options.verifyTaskSet) {
		console.log(
			JSON.stringify(
				{
					valid: true,
					id: taskSet.id,
					tasks: taskSet.tasks.length,
					groups: GROUP_CONFIGURATIONS.map(({ group }) => group),
					plannedRuns: taskSet.tasks.length * GROUP_CONFIGURATIONS.length,
				},
				null,
				2,
			),
		);
	} else {
		const report = await runRealCodingEvaluation(options, taskSet);
		console.log(`Report: ${join(options.outputDirectory, "report.md")}`);
		if (report.aborted || report.passedRuns !== report.totalRuns) process.exitCode = 1;
	}
}
