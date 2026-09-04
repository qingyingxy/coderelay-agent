/**
 * Deterministic JSONL tail-damage recovery evaluation for hard context windows.
 *
 * A genuine Workflow-backed hard-cut session is generated once. Three copies
 * are truncated inside the Snapshot, ContextWindowEntry, or first new-window
 * Assistant message. Each copy must recover, continue, and survive a second
 * reopen without joining new records to the malformed tail.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type FauxProviderRegistration,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	type FileEntry,
	getHistoryResultCount,
	ModelRuntime,
	type ResourceLoader,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
} from "../../src/index.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROBE_SECRET = "tail-recovery-secret=delta-91";
const TEMPLATE_CONTINUATION = "template-new-window-continuation";

type TailScenarioId = "partial-snapshot" | "partial-context-window" | "partial-new-window-continuation";

interface FauxEnvironment {
	readonly workspace: string;
	readonly faux: FauxProviderRegistration;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<string>;
	cleanup(): void;
}

interface TemplateSession {
	readonly physicalLines: readonly string[];
	readonly entries: readonly FileEntry[];
	readonly snapshotLineIndex: number;
	readonly boundaryLineIndex: number;
	readonly continuationLineIndex: number;
}

interface TailScenarioDefinition {
	readonly id: TailScenarioId;
	readonly targetLineIndex: number;
	readonly expectedSnapshots: number;
	readonly expectedBoundaries: number;
	readonly expectedActiveWindow: "old" | "new";
}

export interface TailRecoveryCheck {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

export interface TailRecoveryScenarioResult {
	readonly id: TailScenarioId;
	readonly passed: boolean;
	readonly checks: readonly TailRecoveryCheck[];
	readonly evidence: Readonly<Record<string, unknown>>;
	readonly error?: string;
}

export interface ContextWindowTailRecoveryReport {
	readonly schemaVersion: 1;
	readonly provider: "faux";
	readonly deterministic: true;
	readonly serialExecution: true;
	readonly paidTokens: 0;
	readonly passed: boolean;
	readonly passedScenarios: number;
	readonly totalScenarios: number;
	readonly results: readonly TailRecoveryScenarioResult[];
}

function check(id: string, passed: boolean, detail: string): TailRecoveryCheck {
	return { id, passed, detail };
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") return content;
	if (!content) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function createResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Run the deterministic JSONL tail-recovery evaluation exactly as requested.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function createFauxEnvironment(workspace: string): Promise<FauxEnvironment> {
	const faux = registerFauxProvider({
		models: [{ id: "faux-tail-recovery", contextWindow: 100_000, maxTokens: 4_000 }],
	});
	try {
		const model = faux.getModel();
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		await modelRuntime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });
		return {
			workspace,
			faux,
			modelRuntime,
			model,
			cleanup() {
				faux.unregister();
			},
		};
	} catch (error) {
		faux.unregister();
		throw error;
	}
}

async function createWindowedSession(
	environment: FauxEnvironment,
	sessionManager: SessionManager,
	withProbe = false,
): Promise<AgentSession> {
	const probeTool = defineTool({
		name: "tail_probe",
		label: "Tail probe",
		description: "Return the exact hidden JSONL tail-recovery value.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		execute: async () => ({
			content: [{ type: "text" as const, text: PROBE_SECRET }],
			details: { value: PROBE_SECRET },
		}),
	});
	const created = await createAgentSession({
		cwd: environment.workspace,
		agentDir: environment.workspace,
		modelRuntime: environment.modelRuntime,
		model: environment.model,
		thinkingLevel: "off",
		tools: withProbe ? ["history", "new_context", probeTool.name] : ["history", "new_context"],
		customTools: withProbe ? [probeTool] : undefined,
		resourceLoader: createResourceLoader(),
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true, keepRecentTokens: 16, reserveTokens: 1_000 },
			contextManagement: {
				mode: "windowed",
				reserveTokens: 10_000,
				notesHintMaxBytes: 4_000,
				historyResultMaxBytes: 16_000,
			},
			retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 30_000 } },
		}),
	});
	return created.session;
}

async function createTemplateSession(
	environment: FauxEnvironment,
	sessionsDirectory: string,
): Promise<TemplateSession> {
	const sessionManager = SessionManager.create(environment.workspace, sessionsDirectory);
	const session = await createWindowedSession(environment, sessionManager, true);
	try {
		session.enableWorkflowTracking("direct");
		environment.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("tail_probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(TEMPLATE_CONTINUATION),
		]);
		await session.prompt("Read the hidden probe and cross one Workflow-backed context boundary.");
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Template Session JSONL was not persisted");
		const physicalLines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		const entries = physicalLines.map((line) => JSON.parse(line) as FileEntry);
		const snapshotLineIndex = entries.findIndex(
			(entry) => entry.type === "custom" && entry.customType === WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
		);
		const boundaryLineIndex = entries.findIndex((entry) => entry.type === "context_window");
		const continuationLineIndex = entries.findIndex(
			(entry, index) =>
				index > boundaryLineIndex &&
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				messageText(entry.message) === TEMPLATE_CONTINUATION,
		);
		if (
			snapshotLineIndex < 0 ||
			boundaryLineIndex <= snapshotLineIndex ||
			continuationLineIndex <= boundaryLineIndex
		) {
			throw new Error("Template Session does not contain the expected Snapshot, boundary, and continuation order");
		}
		return { physicalLines, entries, snapshotLineIndex, boundaryLineIndex, continuationLineIndex };
	} finally {
		session.dispose();
	}
}

function countEntries(entries: readonly SessionEntry[], type: SessionEntry["type"]): number {
	return entries.filter((entry) => entry.type === type).length;
}

function countSnapshots(entries: readonly SessionEntry[]): number {
	return entries.filter(
		(entry) => entry.type === "custom" && entry.customType === WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
	).length;
}

function writeTruncatedCopy(
	path: string,
	physicalLines: readonly string[],
	targetLineIndex: number,
): { readonly targetFragment: string } {
	const targetLine = physicalLines[targetLineIndex];
	if (!targetLine) throw new Error(`Missing template line ${targetLineIndex}`);
	const targetFragment = targetLine.slice(0, Math.max(1, Math.floor(targetLine.length / 2)));
	writeFileSync(path, [...physicalLines.slice(0, targetLineIndex), targetFragment].join("\n"), "utf8");
	return { targetFragment };
}

async function evaluateScenario(
	environment: FauxEnvironment,
	sessionsDirectory: string,
	template: TemplateSession,
	definition: TailScenarioDefinition,
): Promise<TailRecoveryScenarioResult> {
	const corruptedFile = join(sessionsDirectory, `${definition.id}.jsonl`);
	const targetEntry = template.entries[definition.targetLineIndex];
	if (!targetEntry || targetEntry.type === "session") throw new Error(`Invalid target entry for ${definition.id}`);
	const { targetFragment } = writeTruncatedCopy(
		corruptedFile,
		template.physicalLines,
		definition.targetLineIndex,
	);
	let session: AgentSession | undefined;
	try {
		const recoveredManager = SessionManager.open(corruptedFile, sessionsDirectory);
		const entriesBeforeContinuation = recoveredManager.getBranch();
		const activeEntriesBeforeContinuation = recoveredManager.buildContextEntries();
		const activeTextBeforeContinuation = JSON.stringify(recoveredManager.buildSessionContext().messages);
		const lineageBeforeContinuation = recoveredManager.getContextWindowLineage();
		const history = recoveredManager.queryHistory({ action: "search", query: PROBE_SECRET }, 16_000);
		const targetWasIgnored = recoveredManager.getEntry(targetEntry.id) === undefined;
		const oldWindowActive =
			activeTextBeforeContinuation.includes(PROBE_SECRET) && lineageBeforeContinuation === null;
		const newWindowActive =
			activeEntriesBeforeContinuation.length === 1 &&
			activeEntriesBeforeContinuation[0]?.type === "context_window" &&
			!activeTextBeforeContinuation.includes(PROBE_SECRET) &&
			lineageBeforeContinuation?.windowIndex === 1;

		session = await createWindowedSession(environment, recoveredManager);
		const continuationMarker = `recovered-continuation=${definition.id}`;
		environment.faux.setResponses([fauxAssistantMessage(continuationMarker)]);
		await session.prompt("Continue after ignoring the incomplete JSONL tail record.");
		session.dispose();
		session = undefined;

		const physicalAfterContinuation = readFileSync(corruptedFile, "utf8");
		const reopenedManager = SessionManager.open(corruptedFile, sessionsDirectory);
		const reopenedEntries = reopenedManager.getBranch();
		const checks = [
			check("partial-entry-ignored", targetWasIgnored, "the incomplete final JSON object is not indexed"),
			check(
				"durable-prefix-preserved",
				countSnapshots(entriesBeforeContinuation) === definition.expectedSnapshots &&
					countEntries(entriesBeforeContinuation, "context_window") === definition.expectedBoundaries,
				"all complete records before the damaged tail retain their expected commit state",
			),
			check(
				"correct-window-restored",
				definition.expectedActiveWindow === "old" ? oldWindowActive : newWindowActive,
				`${definition.expectedActiveWindow} window is active after recovery`,
			),
			check(
				"history-prefix-readable",
				getHistoryResultCount(history) >= 1,
				"History still retrieves the complete pre-boundary probe record",
			),
			check(
				"append-separated-from-tail",
				physicalAfterContinuation.includes(`${targetFragment}\n{`),
				"the first recovered append starts on a new physical line",
			),
			check(
				"continuation-survives-reopen",
				JSON.stringify(reopenedEntries).includes(continuationMarker),
				"the resumed provider response remains readable after a second reopen",
			),
			check(
				"commit-state-not-invented",
				countSnapshots(reopenedEntries) === definition.expectedSnapshots &&
					countEntries(reopenedEntries, "context_window") === definition.expectedBoundaries,
				"continuation neither reconstructs a partial commit nor duplicates a durable one",
			),
		];
		return {
			id: definition.id,
			passed: checks.every(({ passed }) => passed),
			checks,
			evidence: {
				targetEntryType: targetEntry.type,
				persistedEntriesBeforeContinuation: entriesBeforeContinuation.length,
				activeEntriesBeforeContinuation: activeEntriesBeforeContinuation.length,
				snapshotsBeforeContinuation: countSnapshots(entriesBeforeContinuation),
				boundariesBeforeContinuation: countEntries(entriesBeforeContinuation, "context_window"),
				windowIndexBeforeContinuation: lineageBeforeContinuation?.windowIndex,
				historyHits: getHistoryResultCount(history),
				persistedEntriesAfterSecondReopen: reopenedEntries.length,
			},
		};
	} finally {
		session?.dispose();
	}
}

async function runScenario(
	environment: FauxEnvironment,
	sessionsDirectory: string,
	template: TemplateSession,
	definition: TailScenarioDefinition,
): Promise<TailRecoveryScenarioResult> {
	try {
		return await evaluateScenario(environment, sessionsDirectory, template, definition);
	} catch (error) {
		return {
			id: definition.id,
			passed: false,
			checks: [],
			evidence: {},
			error: error instanceof Error ? error.stack ?? error.message : String(error),
		};
	}
}

export async function runContextWindowTailRecoveryEvaluation(): Promise<ContextWindowTailRecoveryReport> {
	const root = mkdtempSync(join(tmpdir(), "pi-context-tail-recovery-"));
	const workspace = join(root, "workspace");
	const sessionsDirectory = join(root, "sessions");
	mkdirSync(workspace, { recursive: true });
	const environment = await createFauxEnvironment(workspace);
	try {
		const template = await createTemplateSession(environment, sessionsDirectory);
		const definitions: readonly TailScenarioDefinition[] = [
			{
				id: "partial-snapshot",
				targetLineIndex: template.snapshotLineIndex,
				expectedSnapshots: 0,
				expectedBoundaries: 0,
				expectedActiveWindow: "old",
			},
			{
				id: "partial-context-window",
				targetLineIndex: template.boundaryLineIndex,
				expectedSnapshots: 1,
				expectedBoundaries: 0,
				expectedActiveWindow: "old",
			},
			{
				id: "partial-new-window-continuation",
				targetLineIndex: template.continuationLineIndex,
				expectedSnapshots: 1,
				expectedBoundaries: 1,
				expectedActiveWindow: "new",
			},
		];
		const results: TailRecoveryScenarioResult[] = [];
		for (const definition of definitions) {
			results.push(await runScenario(environment, sessionsDirectory, template, definition));
		}
		const passedScenarios = results.filter(({ passed }) => passed).length;
		return {
			schemaVersion: 1,
			provider: "faux",
			deterministic: true,
			serialExecution: true,
			paidTokens: 0,
			passed: passedScenarios === results.length,
			passedScenarios,
			totalScenarios: results.length,
			results,
		};
	} finally {
		environment.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === resolve(SCRIPT_PATH) : false;
if (isMain) {
	const report = await runContextWindowTailRecoveryEvaluation();
	console.log(JSON.stringify(report, null, 2));
	if (!report.passed) process.exitCode = 1;
}
