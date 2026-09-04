/**
 * Deterministic OS-process crash recovery evaluation for hard context windows.
 *
 * Each scenario force-exits a child process immediately after one durable write,
 * then opens the same Session JSONL in the parent and verifies recovery. The
 * Faux Provider is local, so this runner uses no network access or paid tokens.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
	getHistoryResultCount,
	ModelRuntime,
	type ResourceLoader,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
} from "../../src/index.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXIT_AFTER_SNAPSHOT = 86;
const EXIT_AFTER_BOUNDARY = 87;
const PROBE_SECRET = "process-recovery-secret=omega-73";

type CrashPoint = "after-snapshot" | "after-boundary";

interface ChildConfiguration {
	readonly workspace: string;
	readonly sessionsDirectory: string;
	readonly statePath: string;
}

interface ChildState {
	readonly schemaVersion: 1;
	readonly crashPoint: CrashPoint;
	readonly sessionFile: string;
}

interface FauxEnvironment {
	readonly workspace: string;
	readonly faux: FauxProviderRegistration;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<string>;
	cleanup(): void;
}

export interface ProcessRecoveryCheck {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

export interface ProcessRecoveryScenarioResult {
	readonly id: CrashPoint;
	readonly passed: boolean;
	readonly expectedExitCode: number;
	readonly exitCode: number | null;
	readonly checks: readonly ProcessRecoveryCheck[];
	readonly evidence: Readonly<Record<string, unknown>>;
	readonly error?: string;
}

export interface ContextWindowProcessRecoveryReport {
	readonly schemaVersion: 1;
	readonly provider: "faux";
	readonly deterministic: true;
	readonly serialExecution: true;
	readonly paidTokens: 0;
	readonly passed: boolean;
	readonly passedScenarios: number;
	readonly totalScenarios: number;
	readonly results: readonly ProcessRecoveryScenarioResult[];
}

function check(id: string, passed: boolean, detail: string): ProcessRecoveryCheck {
	return { id, passed, detail };
}

function createResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Run the deterministic process-recovery evaluation exactly as requested.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function createFauxEnvironment(workspace: string): Promise<FauxEnvironment> {
	const faux = registerFauxProvider({
		models: [{ id: "faux-process-recovery", contextWindow: 100_000, maxTokens: 4_000 }],
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
		name: "crash_probe",
		label: "Crash probe",
		description: "Return the exact process-recovery probe value.",
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

function parseChildConfiguration(path: string): ChildConfiguration {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (
		typeof value !== "object" ||
		value === null ||
		!("workspace" in value) ||
		typeof value.workspace !== "string" ||
		!("sessionsDirectory" in value) ||
		typeof value.sessionsDirectory !== "string" ||
		!("statePath" in value) ||
		typeof value.statePath !== "string"
	) {
		throw new Error("Invalid process-recovery child configuration");
	}
	return {
		workspace: value.workspace,
		sessionsDirectory: value.sessionsDirectory,
		statePath: value.statePath,
	};
}

function readChildState(path: string, crashPoint: CrashPoint): ChildState {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (
		typeof value !== "object" ||
		value === null ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 1 ||
		!("crashPoint" in value) ||
		value.crashPoint !== crashPoint ||
		!("sessionFile" in value) ||
		typeof value.sessionFile !== "string"
	) {
		throw new Error(`Invalid child state for ${crashPoint}`);
	}
	return { schemaVersion: 1, crashPoint, sessionFile: value.sessionFile };
}

async function runCrashChild(crashPoint: CrashPoint, configuration: ChildConfiguration): Promise<never> {
	const environment = await createFauxEnvironment(configuration.workspace);
	const sessionManager = SessionManager.create(configuration.workspace, configuration.sessionsDirectory);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Child Session JSONL path is unavailable");
	writeFileSync(
		configuration.statePath,
		JSON.stringify({ schemaVersion: 1, crashPoint, sessionFile } satisfies ChildState),
		"utf8",
	);
	const session = await createWindowedSession(environment, sessionManager, crashPoint === "after-boundary");
	session.enableWorkflowTracking("direct");

	if (crashPoint === "after-snapshot") {
		Object.defineProperty(sessionManager, "appendContextWindow", {
			configurable: true,
			value: () => process.exit(EXIT_AFTER_SNAPSHOT),
		});
		environment.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
		]);
		await session.prompt("Create a Workflow checkpoint, then start a new context window.");
	} else {
		session.subscribe((event) => {
			if (event.type === "context_window_end") process.exit(EXIT_AFTER_BOUNDARY);
		});
		environment.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("crash_probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("PRE_CRASH_CONTINUATION_MUST_NOT_PERSIST"),
		]);
		await session.prompt("Read the crash probe, then start a new context window.");
	}
	throw new Error(`Child did not terminate at ${crashPoint}`);
}

function spawnCrashChild(crashPoint: CrashPoint, configurationPath: string) {
	return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, "--child", crashPoint, configurationPath], {
		cwd: dirname(SCRIPT_PATH),
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
}

function countEntries(entries: readonly SessionEntry[], type: SessionEntry["type"]): number {
	return entries.filter((entry) => entry.type === type).length;
}

async function evaluateAfterSnapshot(): Promise<ProcessRecoveryScenarioResult> {
	const root = mkdtempSync(join(tmpdir(), "pi-process-recovery-snapshot-"));
	const workspace = join(root, "workspace");
	const sessionsDirectory = join(root, "sessions");
	const configurationPath = join(root, "child-config.json");
	const statePath = join(root, "child-state.json");
	writeFileSync(configurationPath, JSON.stringify({ workspace, sessionsDirectory, statePath }), "utf8");
	let session: AgentSession | undefined;
	let environment: FauxEnvironment | undefined;
	try {
		const child = spawnCrashChild("after-snapshot", configurationPath);
		const state = readChildState(statePath, "after-snapshot");
		if (!existsSync(state.sessionFile)) throw new Error("Child Session JSONL was not persisted");
		const resumedManager = SessionManager.open(state.sessionFile, sessionsDirectory);
		const entriesBeforeResume = resumedManager.getBranch();
		const activeBeforeResume = JSON.stringify(resumedManager.buildSessionContext().messages);
		const snapshotsBeforeResume = entriesBeforeResume.filter(
			(entry) => entry.type === "custom" && entry.customType === WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
		);
		environment = await createFauxEnvironment(workspace);
		session = await createWindowedSession(environment, resumedManager);
		environment.faux.setResponses([fauxAssistantMessage("recovery-after-snapshot-ok")]);
		await session.prompt("Continue without implicitly retrying the interrupted cut.");
		const entriesAfterResume = resumedManager.getBranch();
		const checks = [
			check("expected-process-exit", child.status === EXIT_AFTER_SNAPSHOT, `child exited with ${child.status}`),
			check("snapshot-durable", snapshotsBeforeResume.length === 1, "one Workflow Snapshot survived the crash"),
			check(
				"boundary-not-written",
				countEntries(entriesBeforeResume, "context_window") === 0,
				"no ContextWindowEntry exists before the interrupted append",
			),
			check(
				"old-window-active",
				activeBeforeResume.includes("Create a Workflow checkpoint") && !activeBeforeResume.includes("Context window continuity seed"),
				"resume rebuilds the old active window rather than inventing a seed",
			),
			check("lineage-unchanged", resumedManager.getContextWindowLineage() === null, "lineage remains at the implicit first window"),
			check(
				"resume-continues",
				JSON.stringify(session.messages).includes("recovery-after-snapshot-ok"),
				"a fresh AgentSession completes a provider turn",
			),
			check(
				"cut-not-replayed",
				countEntries(entriesAfterResume, "context_window") === 0,
				"resume does not infer or replay the lost in-memory cut request",
			),
		];
		return {
			id: "after-snapshot",
			passed: checks.every(({ passed }) => passed),
			expectedExitCode: EXIT_AFTER_SNAPSHOT,
			exitCode: child.status,
			checks,
			evidence: {
				sessionFile: state.sessionFile,
				persistedEntriesBeforeResume: entriesBeforeResume.length,
				snapshotsBeforeResume: snapshotsBeforeResume.length,
				boundariesAfterResume: countEntries(entriesAfterResume, "context_window"),
				childSignal: child.signal,
				...(child.stderr.trim() ? { childStderr: child.stderr.trim() } : {}),
			},
		};
	} finally {
		session?.dispose();
		environment?.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
}

async function evaluateAfterBoundary(): Promise<ProcessRecoveryScenarioResult> {
	const root = mkdtempSync(join(tmpdir(), "pi-process-recovery-boundary-"));
	const workspace = join(root, "workspace");
	const sessionsDirectory = join(root, "sessions");
	const configurationPath = join(root, "child-config.json");
	const statePath = join(root, "child-state.json");
	writeFileSync(configurationPath, JSON.stringify({ workspace, sessionsDirectory, statePath }), "utf8");
	let session: AgentSession | undefined;
	let environment: FauxEnvironment | undefined;
	try {
		const child = spawnCrashChild("after-boundary", configurationPath);
		const state = readChildState(statePath, "after-boundary");
		if (!existsSync(state.sessionFile)) throw new Error("Child Session JSONL was not persisted");
		const resumedManager = SessionManager.open(state.sessionFile, sessionsDirectory);
		const entriesBeforeResume = resumedManager.getBranch();
		const activeEntriesBeforeResume = resumedManager.buildContextEntries();
		const activeBeforeResume = JSON.stringify(resumedManager.buildSessionContext().messages);
		const lineageBeforeResume = resumedManager.getContextWindowLineage();
		const boundaries = entriesBeforeResume.filter((entry) => entry.type === "context_window");
		const boundary = boundaries[0];
		const snapshots = entriesBeforeResume.filter(
			(entry) => entry.type === "custom" && entry.customType === WORKFLOW_SNAPSHOT_CUSTOM_TYPE,
		);
		const history = resumedManager.queryHistory({ action: "search", query: PROBE_SECRET }, 16_000);
		environment = await createFauxEnvironment(workspace);
		session = await createWindowedSession(environment, resumedManager);
		environment.faux.setResponses([fauxAssistantMessage("recovery-after-boundary-ok")]);
		await session.prompt("Continue from the already committed context window.");
		const entriesAfterResume = resumedManager.getBranch();
		const checks = [
			check("expected-process-exit", child.status === EXIT_AFTER_BOUNDARY, `child exited with ${child.status}`),
			check(
				"snapshot-and-boundary-durable",
				snapshots.length === 1 && boundaries.length === 1,
				"one Workflow Snapshot and one ContextWindowEntry survived the crash",
			),
			check(
				"boundary-references-snapshot",
				boundary?.type === "context_window" && boundary.snapshotEntryId === snapshots[0]?.id,
				"the committed boundary references the durable Workflow Snapshot",
			),
			check(
				"new-window-active",
				activeEntriesBeforeResume.length === 1 &&
					activeEntriesBeforeResume[0]?.id === boundary?.id &&
					!activeBeforeResume.includes(PROBE_SECRET),
				"resume starts from the persisted seed and excludes the old probe result",
			),
			check(
				"lineage-restored",
				lineageBeforeResume?.windowIndex === 1 && lineageBeforeResume.windowId === boundary?.windowId,
				"window index and ID are recovered from the committed boundary",
			),
			check(
				"history-retains-probe",
				getHistoryResultCount(history) >= 1,
				"History retrieves the exact pre-boundary tool result from the current branch",
			),
			check(
				"continuation-not-persisted",
				!JSON.stringify(entriesBeforeResume).includes("PRE_CRASH_CONTINUATION_MUST_NOT_PERSIST"),
				"the response queued after the boundary was never sampled or written",
			),
			check(
				"resume-continues-once",
				JSON.stringify(session.messages).includes("recovery-after-boundary-ok") &&
					countEntries(entriesAfterResume, "context_window") === 1,
				"a fresh AgentSession continues without duplicating the committed boundary",
			),
		];
		return {
			id: "after-boundary",
			passed: checks.every(({ passed }) => passed),
			expectedExitCode: EXIT_AFTER_BOUNDARY,
			exitCode: child.status,
			checks,
			evidence: {
				sessionFile: state.sessionFile,
				persistedEntriesBeforeResume: entriesBeforeResume.length,
				activeEntriesBeforeResume: activeEntriesBeforeResume.length,
				windowIndex: lineageBeforeResume?.windowIndex,
				historyHits: getHistoryResultCount(history),
				boundariesAfterResume: countEntries(entriesAfterResume, "context_window"),
				childSignal: child.signal,
				...(child.stderr.trim() ? { childStderr: child.stderr.trim() } : {}),
			},
		};
	} finally {
		session?.dispose();
		environment?.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
}

async function runScenario(
	id: CrashPoint,
	expectedExitCode: number,
	run: () => Promise<ProcessRecoveryScenarioResult>,
): Promise<ProcessRecoveryScenarioResult> {
	try {
		return await run();
	} catch (error) {
		return {
			id,
			passed: false,
			expectedExitCode,
			exitCode: null,
			checks: [],
			evidence: {},
			error: error instanceof Error ? error.stack ?? error.message : String(error),
		};
	}
}

export async function runContextWindowProcessRecoveryEvaluation(): Promise<ContextWindowProcessRecoveryReport> {
	const results = [
		await runScenario("after-snapshot", EXIT_AFTER_SNAPSHOT, evaluateAfterSnapshot),
		await runScenario("after-boundary", EXIT_AFTER_BOUNDARY, evaluateAfterBoundary),
	];
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
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === resolve(SCRIPT_PATH) : false;
if (isMain) {
	if (process.argv[2] === "--child") {
		const crashPoint = process.argv[3];
		const configurationPath = process.argv[4];
		if ((crashPoint !== "after-snapshot" && crashPoint !== "after-boundary") || !configurationPath) {
			throw new Error("Usage: evaluate-process-recovery.ts --child <after-snapshot|after-boundary> <config-path>");
		}
		await runCrashChild(crashPoint, parseChildConfiguration(configurationPath));
	} else {
		const report = await runContextWindowProcessRecoveryEvaluation();
		console.log(JSON.stringify(report, null, 2));
		if (!report.passed) process.exitCode = 1;
	}
}
