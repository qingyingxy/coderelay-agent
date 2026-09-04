/**
 * Serial real-model evaluation for context-window memory strategies.
 *
 * This runner makes paid network requests. It deliberately executes one run
 * and one model interaction at a time and writes a checkpoint after each run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
	type AgentSession,
	type ContextManagementMode,
	type ContextManagementTrace,
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	type ResourceLoader,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "../../src/index.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASK_SET_PATH = join(SCRIPT_DIR, "real-task-set.json");
const DEFAULT_MAX_COST_USD = 8;
const DEFAULT_MAX_OUTPUT_TOKENS = 3_000;
const DEFAULT_REPETITIONS = 1;
const EVALUATION_CONTEXT_WINDOW = 272_000;
const PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";

const GROUPS = ["A", "B", "C", "D"] as const;
type EvaluationGroup = (typeof GROUPS)[number];

const ALLOWED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type AllowedThinkingLevel = (typeof ALLOWED_THINKING_LEVELS)[number];

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

type JsonPrimitive = string | number | boolean | null;

export interface RealContextWindowTask {
	readonly id: string;
	readonly description: string;
	readonly durableFacts: readonly string[];
	readonly lookup: {
		readonly recordId: string;
		readonly value: Readonly<Record<string, JsonPrimitive>>;
	};
	readonly expected: Readonly<Record<string, JsonPrimitive>>;
	readonly forbiddenTerms: readonly string[];
	readonly distractorRecords: number;
}

export interface RealContextWindowTaskSet {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly tasks: readonly RealContextWindowTask[];
}

export interface EvaluationTokens {
	readonly input: number;
	readonly output: number;
	readonly reasoning: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

export interface EvaluationCheck {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

export interface ExpectedOutputEvaluation {
	readonly parsed: Readonly<Record<string, unknown>> | null;
	readonly checks: readonly EvaluationCheck[];
}

interface GroupConfiguration {
	readonly group: EvaluationGroup;
	readonly strategy: string;
	readonly mode: ContextManagementMode;
	readonly workflow: boolean;
}

export interface CliOptions {
	readonly provider?: string;
	readonly model?: string;
	readonly thinking: AllowedThinkingLevel;
	readonly taskSetPath: string;
	readonly outputDirectory: string;
	readonly maxCostUsd: number;
	readonly maxOutputTokens: number;
	readonly repetitions: number;
	readonly verifyTaskSet: boolean;
}

interface RunMetrics {
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
}

interface RealEvaluationRunResult {
	readonly taskId: string;
	readonly group: EvaluationGroup;
	readonly repetition: number;
	readonly strategy: string;
	readonly passed: boolean;
	readonly checks: readonly EvaluationCheck[];
	readonly metrics: RunMetrics;
	readonly activeTools: readonly string[];
	readonly finalResponse: string;
	readonly sessionFile?: string;
	readonly traceFile?: string;
	readonly error?: string;
}

interface RealEvaluationReport {
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
		readonly pricingPerMillionTokens: ModelPrice;
		readonly pricingSource: string;
	};
	readonly passedRuns: number;
	readonly totalRuns: number;
	readonly plannedRuns: number;
	readonly estimatedCostUsd: number;
	readonly results: readonly RealEvaluationRunResult[];
}

const GROUP_CONFIGURATIONS: readonly GroupConfiguration[] = [
	{ group: "A", strategy: "summary", mode: "summary", workflow: false },
	{ group: "B", strategy: "windowed + Notes + History", mode: "windowed", workflow: false },
	{
		group: "C",
		strategy: "windowed + Workflow Snapshot + Notes + History",
		mode: "windowed",
		workflow: true,
	},
	{ group: "D", strategy: "hybrid + Workflow Snapshot + Notes + History", mode: "hybrid", workflow: true },
];

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
		if (!key || !["string", "number", "boolean"].includes(typeof item)) {
			if (item !== null) throw new Error(`${path}.${key} must be a JSON primitive`);
		}
	}
	return value as Readonly<Record<string, JsonPrimitive>>;
}

export function parseRealTaskSet(value: unknown): RealContextWindowTaskSet {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Task Set schemaVersion must be 1");
	const id = parseNonEmptyString(value.id, "Task Set id");
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error("Task Set tasks must be non-empty");
	const taskIds = new Set<string>();
	const tasks = value.tasks.map((candidate, index): RealContextWindowTask => {
		const path = `tasks[${index}]`;
		if (!isRecord(candidate)) throw new Error(`${path} must be an object`);
		const taskId = parseNonEmptyString(candidate.id, `${path}.id`);
		if (taskIds.has(taskId)) throw new Error(`Duplicate task id: ${taskId}`);
		taskIds.add(taskId);
		if (!isRecord(candidate.lookup)) throw new Error(`${path}.lookup must be an object`);
		const expected = parsePrimitiveRecord(candidate.expected, `${path}.expected`);
		if (expected.case_id !== taskId) throw new Error(`${path}.expected.case_id must equal ${taskId}`);
		const distractorRecords = candidate.distractorRecords;
		if (!Number.isSafeInteger(distractorRecords) || Number(distractorRecords) < 0) {
			throw new Error(`${path}.distractorRecords must be a non-negative safe integer`);
		}
		return {
			id: taskId,
			description: parseNonEmptyString(candidate.description, `${path}.description`),
			durableFacts: parseStringArray(candidate.durableFacts, `${path}.durableFacts`),
			lookup: {
				recordId: parseNonEmptyString(candidate.lookup.recordId, `${path}.lookup.recordId`),
				value: parsePrimitiveRecord(candidate.lookup.value, `${path}.lookup.value`),
			},
			expected,
			forbiddenTerms: parseStringArray(candidate.forbiddenTerms, `${path}.forbiddenTerms`),
			distractorRecords: Number(distractorRecords),
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
	return resolve(".artifacts", `context-window-real-${suffix}`);
}

export function parseCliOptions(args: readonly string[]): CliOptions {
	let provider: string | undefined;
	let model: string | undefined;
	let thinking: AllowedThinkingLevel = "medium";
	let taskSetPath = DEFAULT_TASK_SET_PATH;
	let outputDirectory = defaultOutputDirectory();
	let maxCostUsd = DEFAULT_MAX_COST_USD;
	let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
	let repetitions = DEFAULT_REPETITIONS;
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
			case "--repetitions": {
				const parsed = parsePositiveNumber(value, argument);
				if (!Number.isSafeInteger(parsed)) throw new Error(`${argument} requires a positive integer`);
				repetitions = parsed;
				break;
			}
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
		verifyTaskSet,
	};
}

export function calculateEstimatedCost(tokens: EvaluationTokens, price: ModelPrice): number {
	return (
		(tokens.input * price.input +
			tokens.cacheRead * price.cacheRead +
			tokens.cacheWrite * price.cacheWrite +
			tokens.output * price.output) /
		1_000_000
	);
}

export function extractJsonObject(text: string): Readonly<Record<string, unknown>> | null {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = fenced?.[1] ?? trimmed;
	try {
		const parsed: unknown = JSON.parse(candidate);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function check(id: string, passed: boolean, detail: string): EvaluationCheck {
	return { id, passed, detail };
}

export function evaluateExpectedOutput(text: string, task: RealContextWindowTask): ExpectedOutputEvaluation {
	const parsed = extractJsonObject(text);
	const expectedKeys = Object.keys(task.expected);
	const actualKeys = parsed ? Object.keys(parsed) : [];
	const checks: EvaluationCheck[] = [
		check("parseable-json", parsed !== null, parsed ? "final response is a JSON object" : "final response is not JSON"),
		check(
			"exact-keys",
			parsed !== null && JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
			`expected keys ${expectedKeys.join(", ")}; received ${actualKeys.join(", ") || "none"}`,
		),
	];
	for (const [key, expected] of Object.entries(task.expected)) {
		checks.push(check(`value:${key}`, parsed?.[key] === expected, `${key} must equal ${JSON.stringify(expected)}`));
	}
	const normalized = text.toLowerCase();
	for (const term of task.forbiddenTerms) {
		checks.push(
			check(`forbidden:${term}`, !normalized.includes(term.toLowerCase()), `final response must not contain ${term}`),
		);
	}
	return { parsed, checks };
}

function createResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () =>
			"Run the controlled context-memory evaluation. Follow the phase instructions exactly. Use Notes only for durable user facts, use History for old exact tool results, and emit strict JSON when requested.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function createLookupTool(task: RealContextWindowTask) {
	return defineTool({
		name: "benchmark_lookup",
		label: "Benchmark lookup",
		description: `Read the immutable benchmark record ${task.lookup.recordId}.`,
		promptSnippet: "Read one immutable benchmark record by record_id",
		parameters: Type.Object({ record_id: Type.String() }),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			if (params.record_id !== task.lookup.recordId) throw new Error(`Unknown benchmark record: ${params.record_id}`);
			const result = { record_id: task.lookup.recordId, ...task.lookup.value };
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
		},
	});
}

function distractorAppendix(task: RealContextWindowTask): string {
	const lines: string[] = [];
	for (let index = 0; index < task.distractorRecords; index++) {
		const ordinal = index.toString().padStart(4, "0");
		const checksum = ((index + 17) * 7919).toString(16).padStart(6, "0");
		lines.push(
			`D${ordinal} non-authoritative archive record: owner=team-${index % 19}; action=ignore-${ordinal}; checksum=${checksum}.`,
		);
	}
	return lines.join("\n");
}

function setupPrompt(task: RealContextWindowTask): string {
	const noteArguments = {
		action: "upsert",
		note_id: `${task.id}-durable-facts`,
		category: "constraint",
		content: task.durableFacts.join(" "),
		source_entry_ids: [],
	};
	return [
		"This is phase 1 of a controlled long-context memory evaluation.",
		`External case_id: ${task.id}`,
		`Purpose: ${task.description}`,
		"Durable facts:",
		...task.durableFacts.map((fact) => `- ${fact}`),
		"If the notes tool is available, call it once with exactly these arguments and omit every other field:",
		JSON.stringify(noteArguments),
		`Call benchmark_lookup exactly once with record_id ${JSON.stringify(task.lookup.recordId)}.`,
		"Do not copy the lookup result into Notes and do not quote it in your visible response.",
		"After the lookup completes, reply exactly READY.",
		"The following appendix is distractor data. It is non-authoritative and must not be saved in Notes:",
		distractorAppendix(task),
	].join("\n");
}

function checkpointPrompt(requestHardCut: boolean): string {
	if (requestHardCut) {
		return [
			"Phase 1 is complete. Start the controlled context boundary now.",
			"Call new_context exactly once with an empty object and do not call any other tool.",
			"After the tool completes, the benchmark removes new_context from the fresh window.",
			"When new_context is no longer available, reply exactly CHECKPOINT_READY without calling a tool.",
			`Non-authoritative padding: ${"checkpoint-padding ".repeat(48)}`,
		].join("\n");
	}
	return [
		"Phase 1 is complete. Do not call any tool in this turn.",
		"Reply exactly CHECKPOINT_READY.",
		`Non-authoritative padding: ${"checkpoint-padding ".repeat(48)}`,
	].join("\n");
}

function finalPrompt(task: RealContextWindowTask): string {
	const keys = Object.keys(task.expected).join(", ");
	const historyArguments = {
		action: "search",
		query: task.lookup.recordId,
		role: "toolResult",
		tool: "benchmark_lookup",
		window_id: null,
		entry_ids: null,
		cursor: null,
		limit: 10,
	};
	return [
		"This is the final validation phase after the context boundary.",
		`Recover the durable facts for external case_id ${task.id}.`,
		"If History is available, call it once with exactly these arguments:",
		JSON.stringify(historyArguments),
		"Use the matching excerpt directly; do not make a list request and do not guess.",
		`Return exactly one JSON object with these keys in this order: ${keys}.`,
		"Use the external case_id exactly as provided. Do not substitute record_id or a Workflow-internal ID for case_id or domain_task_id.",
		"Use the exact stored values. Do not add keys, Markdown, or explanation.",
	].join("\n");
}

function lastLookupResultEntry(branch: readonly SessionEntry[]): Extract<SessionEntry, { type: "message" }> | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "benchmark_lookup") {
			return entry;
		}
	}
	return undefined;
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

function collectMetrics(session: AgentSession, price: ModelPrice, startedAt: number): RunMetrics {
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
	};
}

function emptyMetrics(startedAt: number): RunMetrics {
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
	};
}

function ensureBudget(session: AgentSession, completedCostUsd: number, maxCostUsd: number, price: ModelPrice): void {
	const current = collectMetrics(session, price, Date.now()).estimatedCostUsd;
	if (completedCostUsd + current > maxCostUsd) {
		throw new Error(
			`Evaluation budget exceeded: $${(completedCostUsd + current).toFixed(6)} > $${maxCostUsd.toFixed(2)}`,
		);
	}
}

function strategyChecks(
	configuration: GroupConfiguration,
	trace: ContextManagementTrace,
	lookupEntry: Extract<SessionEntry, { type: "message" }> | undefined,
	rawLookupActiveAfterBoundary: boolean,
	branch: readonly SessionEntry[],
): readonly EvaluationCheck[] {
	const hardCut = configuration.group !== "A";
	return [
		check(
			"boundary-route",
			hardCut ? trace.stats.hardCuts.count === 1 && trace.stats.summaries.count === 0 : trace.stats.summaries.count === 1 && trace.stats.hardCuts.count === 0,
			`hard cuts=${trace.stats.hardCuts.count}; summaries=${trace.stats.summaries.count}`,
		),
		check(
			"lookup-called",
			lookupEntry !== undefined,
			lookupEntry ? `lookup result Entry ${lookupEntry.id} exists` : "benchmark_lookup was not called",
		),
		check(
			"raw-history-retained",
			lookupEntry !== undefined && branch.some((entry) => entry.id === lookupEntry.id),
			"the original lookup tool result remains in Session JSONL",
		),
		check(
			"raw-history-not-active-after-boundary",
			lookupEntry !== undefined && !rawLookupActiveAfterBoundary,
			"the original lookup result Entry is outside active history immediately after the boundary",
		),
		check(
			"notes-used",
			hardCut ? trace.stats.notes.operationCount >= 1 : trace.stats.notes.operationCount === 0,
			`Note operations=${trace.stats.notes.operationCount}`,
		),
		check(
			"history-used",
			hardCut ? trace.stats.history.queryCount >= 1 : trace.stats.history.queryCount === 0,
			`History queries=${trace.stats.history.queryCount}`,
		),
		check(
			"history-hit",
			hardCut ? trace.historyQueries.some((query) => query.resultCount >= 1) : true,
			`History hits=${trace.historyQueries.reduce((sum, query) => sum + query.resultCount, 0)}`,
		),
		check(
			"workflow-snapshot",
			configuration.workflow
				? trace.windows.some((window) => window.snapshotEntryId !== undefined && window.workflowId !== undefined)
				: trace.windows.every((window) => window.snapshotEntryId === undefined),
			configuration.workflow ? "hard-cut boundary references a Workflow Snapshot" : "no Workflow Snapshot expected",
		),
	];
}

async function runCase(options: {
	readonly task: RealContextWindowTask;
	readonly configuration: GroupConfiguration;
	readonly repetition: number;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	readonly price: ModelPrice;
	readonly outputDirectory: string;
	readonly completedCostUsd: number;
	readonly maxCostUsd: number;
}): Promise<RealEvaluationRunResult> {
	const { task, configuration, repetition, modelRuntime, model, thinking, price, completedCostUsd, maxCostUsd } = options;
	const startedAt = Date.now();
	const runDirectory = join(
		options.outputDirectory,
		`repeat-${repetition.toString().padStart(2, "0")}`,
		`${task.id}-${configuration.group}`,
	);
	const workspace = join(runDirectory, "workspace");
	const sessions = join(runDirectory, "sessions");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	const sessionManager = SessionManager.create(workspace, sessions);
	let session: AgentSession | undefined;
	let activeTools: readonly string[] = [];
	let finalResponse = "";
	let lookupEntry: Extract<SessionEntry, { type: "message" }> | undefined;
	let rawLookupActiveAfterBoundary = true;
	let error: string | undefined;
	let unsubscribe = () => {};
	try {
		const hardCut = configuration.group !== "A";
		const created = await createAgentSession({
			cwd: workspace,
			modelRuntime,
			model,
			thinkingLevel: thinking,
			tools: hardCut ? ["benchmark_lookup", "notes", "history", "new_context"] : ["benchmark_lookup"],
			customTools: [createLookupTool(task)],
			resourceLoader: createResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 4_000 },
				contextManagement: {
					mode: configuration.mode,
					reserveTokens: 16_000,
					notesHintMaxBytes: 4_000,
					historyResultMaxBytes: 16_000,
				},
				retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120_000 } },
			}),
		});
		session = created.session;
		if (configuration.workflow) session.enableWorkflowTracking("direct");
		activeTools = session.getActiveToolNames();
		if (hardCut) {
			const activeSession = session;
			let boundaryCompleted = false;
			unsubscribe = activeSession.subscribe((event) => {
				if (boundaryCompleted || event.type !== "context_window_end" || event.reason !== "model") return;
				boundaryCompleted = true;
				activeSession.setActiveToolsByName(
					activeSession.getActiveToolNames().filter((name) => name !== "new_context"),
				);
			});
		}

		await session.prompt(setupPrompt(task));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		lookupEntry = lastLookupResultEntry(sessionManager.getBranch());

		await session.prompt(checkpointPrompt(hardCut));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);

		if (!hardCut) {
			const compactResult = await session.compactForCommand(
				"Preserve every durable fact from phase 1 and the exact benchmark_lookup result needed by the final validation.",
			);
			if (compactResult.strategy !== "summary") {
				throw new Error(`Expected summary boundary, received ${compactResult.strategy}`);
			}
			ensureBudget(session, completedCostUsd, maxCostUsd, price);
		}
		rawLookupActiveAfterBoundary =
			lookupEntry !== undefined && sessionManager.buildContextEntries().some((entry) => entry.id === lookupEntry?.id);

		await session.prompt(finalPrompt(task));
		ensureBudget(session, completedCostUsd, maxCostUsd, price);
		finalResponse = lastAssistantText(sessionManager.getBranch());
	} catch (caught) {
		error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
	}

	const trace = session?.getContextManagementTrace();
	const branch = sessionManager.getBranch();
	const outputEvaluation = evaluateExpectedOutput(finalResponse, task);
	const checks = trace
		? [
				...outputEvaluation.checks,
				...strategyChecks(configuration, trace, lookupEntry, rawLookupActiveAfterBoundary, branch),
			]
		: outputEvaluation.checks;
	const metrics = session ? collectMetrics(session, price, startedAt) : emptyMetrics(startedAt);
	const sessionFile = session?.sessionFile;
	const traceFile = trace ? join(runDirectory, "context-management-trace.json") : undefined;
	if (traceFile && trace) writeFileSync(traceFile, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
	writeFileSync(join(runDirectory, "final-response.txt"), `${finalResponse}\n`, "utf8");
	const result: RealEvaluationRunResult = {
		taskId: task.id,
		group: configuration.group,
		repetition,
		strategy: configuration.strategy,
		passed: error === undefined && checks.every(({ passed }) => passed),
		checks,
		metrics,
		activeTools,
		finalResponse,
		...(sessionFile ? { sessionFile } : {}),
		...(traceFile ? { traceFile } : {}),
		...(error ? { error } : {}),
	};
	writeFileSync(join(runDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
	unsubscribe();
	session?.dispose();
	return result;
}

function markdownReport(report: RealEvaluationReport): string {
	const rows = report.results.map((result) => {
		const metrics = result.metrics;
		return `| ${result.repetition} | ${result.group} | ${result.taskId} | ${result.passed ? "PASS" : "FAIL"} | ${metrics.providerCalls} | ${metrics.tokens.input} | ${metrics.tokens.output} | ${metrics.tokens.reasoning} | ${metrics.tokens.cacheRead} | ${metrics.historyQueries}/${metrics.historyHits} | ${metrics.noteOperations} | ${metrics.snapshotReferences} | $${metrics.estimatedCostUsd.toFixed(6)} | ${metrics.durationMs} |`;
	});
	return [
		"# Real Context Window Evaluation",
		"",
		`- Task Set: \`${report.taskSetId}\``,
		`- Model: \`${report.configuration.provider}/${report.configuration.model}\``,
		`- Thinking: \`${report.configuration.thinking}\``,
		`- Repetitions: ${report.configuration.repetitions}`,
		`- Execution: serial`,
		`- Result: ${report.passedRuns}/${report.totalRuns} passed${report.aborted ? " (aborted)" : ""}`,
		`- Estimated cost: $${report.estimatedCostUsd.toFixed(6)} / $${report.configuration.maxCostUsd.toFixed(2)}`,
		`- Pricing: [OpenAI API pricing](${report.configuration.pricingSource})`,
		"",
		"| Repeat | Group | Task | Result | Calls | Input | Output | Reasoning | Cache read | History q/h | Notes | Snapshots | Cost | ms |",
		"|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
		...rows,
		"",
	].join("\n");
}

function writeCheckpoint(
	path: string,
	configuration: RealEvaluationReport["configuration"],
	taskSetId: string,
	results: readonly RealEvaluationRunResult[],
): void {
	writeFileSync(
		path,
		`${JSON.stringify({ schemaVersion: 1, taskSetId, serialExecution: true, configuration, results }, null, 2)}\n`,
		"utf8",
	);
}

async function runRealEvaluation(options: CliOptions, taskSet: RealContextWindowTaskSet): Promise<RealEvaluationReport> {
	const settings = SettingsManager.create(process.cwd());
	const provider = options.provider ?? settings.getDefaultProvider();
	const requestedModel = options.model ?? settings.getDefaultModel();
	if (!provider || !requestedModel) {
		throw new Error("Real evaluation requires --provider and --model, or active Pi provider/model settings");
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
	const configuration: RealEvaluationReport["configuration"] = {
		provider,
		model: model.id,
		thinking: options.thinking,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		maxCostUsd: options.maxCostUsd,
		repetitions: options.repetitions,
		pricingPerMillionTokens: price,
		pricingSource: PRICING_SOURCE,
	};
	if (existsSync(join(options.outputDirectory, "report.json"))) {
		throw new Error(`Output directory already contains a report: ${options.outputDirectory}`);
	}
	mkdirSync(options.outputDirectory, { recursive: true });
	const startedAt = new Date().toISOString();
	const results: RealEvaluationRunResult[] = [];
	let completedCostUsd = 0;
	let aborted = false;
	const checkpointPath = join(options.outputDirectory, "checkpoint.json");
	for (let repetition = 1; repetition <= options.repetitions; repetition++) {
		for (const task of taskSet.tasks) {
			for (const group of GROUP_CONFIGURATIONS) {
				if (completedCostUsd >= options.maxCostUsd) {
					aborted = true;
					break;
				}
				console.log(`[RUN] repeat ${repetition}/${options.repetitions} / ${group.group} / ${task.id} / serial`);
				const result = await runCase({
					task,
					configuration: group,
					repetition,
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
					`[${result.passed ? "PASS" : "FAIL"}] repeat ${repetition}/${options.repetitions} / ${group.group} / ${task.id} / $${result.metrics.estimatedCostUsd.toFixed(6)} / cumulative $${completedCostUsd.toFixed(6)}`,
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
	const report: RealEvaluationReport = {
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
		plannedRuns: taskSet.tasks.length * GROUPS.length * options.repetitions,
		estimatedCostUsd: completedCostUsd,
		results,
	};
	writeFileSync(join(options.outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	writeFileSync(join(options.outputDirectory, "report.md"), markdownReport(report), "utf8");
	return report;
}

const isMain = process.argv[1]?.endsWith("evaluate-real.ts") ?? false;
if (isMain) {
	const options = parseCliOptions(process.argv.slice(2));
	const taskSet = parseRealTaskSet(JSON.parse(readFileSync(options.taskSetPath, "utf8")));
	if (options.verifyTaskSet) {
		console.log(
			JSON.stringify(
				{
					valid: true,
					id: taskSet.id,
					tasks: taskSet.tasks.length,
					repetitions: options.repetitions,
					plannedRuns: taskSet.tasks.length * GROUPS.length * options.repetitions,
				},
				null,
				2,
			),
		);
	} else {
		const report = await runRealEvaluation(options, taskSet);
		console.log(`Report: ${join(options.outputDirectory, "report.md")}`);
		if (report.aborted || report.passedRuns !== report.totalRuns) process.exitCode = 1;
	}
}
