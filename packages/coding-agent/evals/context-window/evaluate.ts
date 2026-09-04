/**
 * Deterministic context-management evaluation.
 *
 * Uses only the Faux Provider. No network access, credentials, or paid tokens
 * are required.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type ContextManagementMode,
	type ContextManagementTrace,
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "../../src/index.ts";

type EvaluationGroup = "A" | "B" | "C" | "D";

export interface ContextWindowEvaluationCheck {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

export interface ContextWindowEvaluationMetrics {
	readonly providerCalls: number;
	readonly persistedEntries: number;
	readonly persistedMessages: number;
	readonly activeMessages: number;
	readonly estimatedActiveTokens: number;
	readonly hardCuts: number;
	readonly summaries: number;
	readonly historyQueries: number;
	readonly noteOperations: number;
}

export interface ContextWindowEvaluationFailureArtifact {
	readonly branch: readonly SessionEntry[];
	readonly activeMessages: readonly unknown[];
	readonly trace: ContextManagementTrace;
}

export interface ContextWindowEvaluationCaseResult {
	readonly group: EvaluationGroup;
	readonly strategy: string;
	readonly passed: boolean;
	readonly checks: readonly ContextWindowEvaluationCheck[];
	readonly metrics: ContextWindowEvaluationMetrics;
	readonly failureArtifacts: readonly ContextWindowEvaluationFailureArtifact[];
	readonly error?: string;
}

export interface ContextWindowEvaluationReport {
	readonly schemaVersion: 1;
	readonly provider: "faux";
	readonly deterministic: true;
	readonly passed: boolean;
	readonly passedCases: number;
	readonly totalCases: number;
	readonly results: readonly ContextWindowEvaluationCaseResult[];
}

interface EvaluationSession {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly faux: FauxProviderRegistration;
	cleanup(): void;
}

interface SessionObservation {
	readonly checks: readonly ContextWindowEvaluationCheck[];
	readonly metrics: ContextWindowEvaluationMetrics;
	readonly failureArtifacts: readonly ContextWindowEvaluationFailureArtifact[];
}

const EXACT_VALUE = "build-checksum=7f31c9";
const DURABLE_CONSTRAINT = "Preserve the exact build checksum across context windows.";

function createResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Run the deterministic context-management evaluation.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function createEvaluationSession(mode: ContextManagementMode): Promise<EvaluationSession> {
	const workspace = mkdtempSync(join(tmpdir(), `pi-context-window-eval-${mode}-`));
	const faux = registerFauxProvider({
		models: [{ id: "faux-context-window-eval", contextWindow: 100_000, maxTokens: 4_000 }],
	});
	let session: AgentSession | undefined;
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

		const sessionManager = SessionManager.inMemory(workspace);
		const created = await createAgentSession({
			cwd: workspace,
			agentDir: workspace,
			model,
			modelRuntime,
			resourceLoader: createResourceLoader(),
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, keepRecentTokens: 16, reserveTokens: 1_000 },
				contextManagement: {
					mode,
					reserveTokens: 10_000,
					notesHintMaxBytes: 4_000,
					historyResultMaxBytes: 16_000,
				},
				retry: { enabled: false },
			}),
		});
		session = created.session;
		return {
			session,
			sessionManager,
			faux,
			cleanup() {
				session?.dispose();
				faux.unregister();
				rmSync(workspace, { recursive: true, force: true });
			},
		};
	} catch (error) {
		session?.dispose();
		faux.unregister();
		rmSync(workspace, { recursive: true, force: true });
		throw error;
	}
}

function check(id: string, passed: boolean, detail: string): ContextWindowEvaluationCheck {
	return { id, passed, detail };
}

function collectMetrics(evaluation: EvaluationSession): ContextWindowEvaluationMetrics {
	const branch = evaluation.sessionManager.getBranch();
	const stats = evaluation.session.getContextManagementTrace().stats;
	return {
		providerCalls: evaluation.faux.state.callCount,
		persistedEntries: branch.length,
		persistedMessages: branch.filter((entry) => entry.type === "message").length,
		activeMessages: evaluation.session.messages.length,
		estimatedActiveTokens: stats.currentWindow.estimatedTokens,
		hardCuts: stats.hardCuts.count,
		summaries: stats.summaries.count,
		historyQueries: stats.history.queryCount,
		noteOperations: stats.notes.operationCount,
	};
}

function failureArtifacts(
	evaluation: EvaluationSession,
	checks: readonly ContextWindowEvaluationCheck[],
): readonly ContextWindowEvaluationFailureArtifact[] {
	if (checks.every(({ passed }) => passed)) return [];
	return [
		{
			branch: evaluation.sessionManager.getBranch(),
			activeMessages: evaluation.session.messages,
			trace: evaluation.session.getContextManagementTrace(),
		},
	];
}

function combineMetrics(
	left: ContextWindowEvaluationMetrics,
	right: ContextWindowEvaluationMetrics,
): ContextWindowEvaluationMetrics {
	return {
		providerCalls: left.providerCalls + right.providerCalls,
		persistedEntries: left.persistedEntries + right.persistedEntries,
		persistedMessages: left.persistedMessages + right.persistedMessages,
		activeMessages: left.activeMessages + right.activeMessages,
		estimatedActiveTokens: left.estimatedActiveTokens + right.estimatedActiveTokens,
		hardCuts: left.hardCuts + right.hardCuts,
		summaries: left.summaries + right.summaries,
		historyQueries: left.historyQueries + right.historyQueries,
		noteOperations: left.noteOperations + right.noteOperations,
	};
}

function emptyMetrics(): ContextWindowEvaluationMetrics {
	return {
		providerCalls: 0,
		persistedEntries: 0,
		persistedMessages: 0,
		activeMessages: 0,
		estimatedActiveTokens: 0,
		hardCuts: 0,
		summaries: 0,
		historyQueries: 0,
		noteOperations: 0,
	};
}

async function observeSummary(mode: "summary" | "hybrid"): Promise<SessionObservation> {
	const evaluation = await createEvaluationSession(mode);
	try {
		evaluation.faux.setResponses([
			fauxAssistantMessage(EXACT_VALUE),
			fauxAssistantMessage("Recent work is complete."),
			fauxAssistantMessage(`## Critical Context\n- ${EXACT_VALUE}`),
		]);
		await evaluation.session.prompt("Record the exact build checksum for later verification.");
		const oldMessage = evaluation.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes(EXACT_VALUE),
			);
		await evaluation.session.prompt(
			"Complete the current work while keeping the prior checksum available for a later verification step.",
		);
		const result = await evaluation.session.compactForCommand("Retain the exact build checksum");
		const trace = evaluation.session.getContextManagementTrace();
		const activeEntries = evaluation.sessionManager.buildContextEntries();
		const branch = evaluation.sessionManager.getBranch();
		const checks = [
			check("summary-route", result.strategy === "summary", `compact strategy was ${result.strategy}`),
			check("one-summary", trace.stats.summaries.count === 1, `summary count was ${trace.stats.summaries.count}`),
			check("no-hard-cut", trace.stats.hardCuts.count === 0, `hard-cut count was ${trace.stats.hardCuts.count}`),
			check(
				"raw-history-retained",
				oldMessage !== undefined && branch.some(({ id }) => id === oldMessage.id),
				"the original Assistant Entry remains in the Session branch",
			),
			check(
				"raw-history-not-active",
				oldMessage !== undefined && !activeEntries.some(({ id }) => id === oldMessage.id),
				"the original Assistant Entry is outside active history",
			),
			check(
				"summary-preserves-control",
				activeEntries.some((entry) => entry.type === "compaction" && entry.summary.includes(EXACT_VALUE)),
				"the deterministic summary contains the control value",
			),
		];
		return {
			checks,
			metrics: collectMetrics(evaluation),
			failureArtifacts: failureArtifacts(evaluation, checks),
		};
	} finally {
		evaluation.cleanup();
	}
}

async function observeWindowed(
	mode: "windowed" | "hybrid",
	withWorkflow: boolean,
): Promise<SessionObservation> {
	const evaluation = await createEvaluationSession(mode);
	try {
		if (withWorkflow) evaluation.session.enableWorkflowTracking("direct");
		let retrievalContext = "";
		evaluation.faux.setResponses([
			fauxAssistantMessage(EXACT_VALUE),
			fauxAssistantMessage(
				[
					fauxToolCall(
						"notes",
						{
							action: "upsert",
							note_id: "checksum-constraint",
							category: "constraint",
							content: DURABLE_CONSTRAINT,
						},
						{ id: `notes-${mode}-${withWorkflow ? "workflow" : "plain"}` },
					),
					fauxToolCall(
						"new_context",
						{},
						{ id: `new-context-${mode}-${withWorkflow ? "workflow" : "plain"}` },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Continued from the durable context seed."),
			fauxAssistantMessage(
				fauxToolCall(
					"history",
					{ action: "search", query: EXACT_VALUE },
					{ id: `history-${mode}-${withWorkflow ? "workflow" : "plain"}` },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				retrievalContext = JSON.stringify(context.messages);
				return fauxAssistantMessage(`Recovered ${EXACT_VALUE}`);
			},
		]);
		await evaluation.session.prompt("Record the exact build checksum for later verification.");
		const oldMessage = evaluation.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes(EXACT_VALUE),
			);
		await evaluation.session.prompt("Save the checksum preservation rule as a durable constraint.");
		const branchAfterCut = evaluation.sessionManager.getBranch();
		let boundary: Extract<SessionEntry, { type: "context_window" }> | undefined;
		for (let index = branchAfterCut.length - 1; index >= 0; index--) {
			const entry = branchAfterCut[index];
			if (entry.type === "context_window") {
				boundary = entry;
				break;
			}
		}
		await evaluation.session.prompt("Recover the exact checksum from the old window.");

		const trace = evaluation.session.getContextManagementTrace();
		const branch = evaluation.sessionManager.getBranch();
		const activeEntries = evaluation.sessionManager.buildContextEntries();
		const snapshot = boundary?.snapshotEntryId
			? evaluation.sessionManager.getEntry(boundary.snapshotEntryId)
			: undefined;
		const checks = [
			check(
				"hard-cut-route",
				boundary?.reason === "model",
				`model-requested boundary reason was ${boundary?.reason ?? "missing"}`,
			),
			check("one-hard-cut", trace.stats.hardCuts.count === 1, `hard-cut count was ${trace.stats.hardCuts.count}`),
			check("no-summary", trace.stats.summaries.count === 0, `summary count was ${trace.stats.summaries.count}`),
			check(
				"raw-history-retained",
				oldMessage !== undefined && branch.some(({ id }) => id === oldMessage.id),
				"the original Assistant Entry remains in the Session branch",
			),
			check(
				"raw-history-not-active",
				oldMessage !== undefined && !activeEntries.some(({ id }) => id === oldMessage.id),
				"the original Assistant Entry is outside active history",
			),
			check(
				"note-seeded",
				boundary?.contextSeed.content.includes(DURABLE_CONSTRAINT) === true &&
					boundary.contextSeed.noteEntryIds.length === 1,
				"the durable Note is frozen into the new-window seed",
			),
			check(
				"history-retrieved-control",
				trace.stats.history.queryCount === 1 && retrievalContext.includes(EXACT_VALUE),
				"History returned the exact control value to the Faux Provider",
			),
			check(
				"history-request-traced",
				trace.historyQueries[0]?.request?.query === EXACT_VALUE && trace.historyQueries[0]?.resultCount === 1,
				"the History request and one result are present in the trace",
			),
			check(
				"workflow-snapshot-route",
				withWorkflow
					? snapshot?.type === "custom" &&
						snapshot.customType === "workflow-snapshot" &&
						boundary?.contextSeed.content.includes("Workflow Snapshot is authoritative") === true
					: boundary?.snapshotEntryId === undefined &&
						!boundary?.contextSeed.content.includes("Workflow Snapshot is authoritative"),
				withWorkflow
					? "the boundary references a Workflow Snapshot and injects its projection"
					: "the plain windowed session does not invent a Workflow Snapshot",
			),
		];
		return {
			checks,
			metrics: collectMetrics(evaluation),
			failureArtifacts: failureArtifacts(evaluation, checks),
		};
	} finally {
		evaluation.cleanup();
	}
}

async function evaluateCase(
	group: EvaluationGroup,
	strategy: string,
	run: () => Promise<SessionObservation>,
): Promise<ContextWindowEvaluationCaseResult> {
	try {
		const observation = await run();
		return {
			group,
			strategy,
			passed: observation.checks.every(({ passed }) => passed),
			checks: observation.checks,
			metrics: observation.metrics,
			failureArtifacts: observation.failureArtifacts,
		};
	} catch (error) {
		return {
			group,
			strategy,
			passed: false,
			checks: [],
			metrics: emptyMetrics(),
			failureArtifacts: [],
			error: error instanceof Error ? error.stack ?? error.message : String(error),
		};
	}
}

async function evaluateHybrid(): Promise<SessionObservation> {
	const plain = await observeSummary("hybrid");
	const workflow = await observeWindowed("hybrid", true);
	const checks = [
		check(
			"plain-chat-summary",
			plain.checks.every(({ passed }) => passed) && plain.metrics.summaries === 1 && plain.metrics.hardCuts === 0,
			"plain hybrid chat uses summary compaction",
		),
		check(
			"workflow-hard-cut",
			workflow.checks.every(({ passed }) => passed) &&
				workflow.metrics.hardCuts === 1 &&
				workflow.metrics.summaries === 0,
			"hybrid with an active Workflow uses a Snapshot-backed hard cut",
		),
	];
	return {
		checks,
		metrics: combineMetrics(plain.metrics, workflow.metrics),
		failureArtifacts: [...plain.failureArtifacts, ...workflow.failureArtifacts],
	};
}

export async function runContextWindowEvaluation(): Promise<ContextWindowEvaluationReport> {
	// Faux providers use a process-global registry, so cases must not overlap.
	const results = [
		await evaluateCase("A", "summary", () => observeSummary("summary")),
		await evaluateCase("B", "windowed + Notes + History", () => observeWindowed("windowed", false)),
		await evaluateCase("C", "windowed + Workflow Snapshot + Notes + History", () =>
			observeWindowed("windowed", true),
		),
		await evaluateCase("D", "hybrid", evaluateHybrid),
	];
	const passedCases = results.filter(({ passed }) => passed).length;
	return {
		schemaVersion: 1,
		provider: "faux",
		deterministic: true,
		passed: passedCases === results.length,
		passedCases,
		totalCases: results.length,
		results,
	};
}

const isMain = process.argv[1]?.endsWith("evaluate.ts") ?? false;
if (isMain) {
	const report = await runContextWindowEvaluation();
	console.log(JSON.stringify(report, null, 2));
	if (!report.passed) process.exitCode = 1;
}
