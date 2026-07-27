/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { DeliveryRuntime, type ReadonlyReviewer, SubagentReadonlyReviewer } from "./delivery/index.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { formatJob, formatJobLogs, formatJobs, type Job, JobRuntime, LocalJobProcessFactory } from "./jobs/index.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import {
	type AgentRunResult,
	formatAgentDetails,
	formatAgentEvents,
	formatAgentList,
	formatAgentRunResult,
	RpcSubagentSessionFactory,
	SubagentRuntime,
} from "./subagents/index.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";
import { type AgentSessionAdapter, startDirectAgentSessionWorkflow } from "./workflow/agent-session-adapter.ts";
import { createWorkflowAutomationPolicy, requiresPlanMode } from "./workflow/autonomous-workflow-policy.ts";
import { AutonomousWorkflowRunner } from "./workflow/autonomous-workflow-runner.ts";
import type { AutonomousWorkflowEvent, WorkflowAutomationResult } from "./workflow/autonomous-workflow-types.ts";
import type { RequiredClarification } from "./workflow/clarification-gate.ts";
import { decideDirectPlanUpgrade } from "./workflow/direct-plan-upgrade.ts";
import {
	createModeAdvisorPromptEnvelope,
	executeModeAdvisorPrompt,
	parseModeAdvisorResult,
} from "./workflow/mode-advisor-runtime.ts";
import { createModeDecision } from "./workflow/mode-decision.ts";
import { selectExecutionMode } from "./workflow/mode-selector.ts";
import {
	type JobTaskExecution,
	PlanWorkflowRuntime,
	type SubagentTaskExecution,
	type WorkflowTaskExecution,
} from "./workflow/plan-runtime.ts";
import {
	createPlannerPromptEnvelope,
	executePlannerPrompt,
	parsePlannerPlanContent,
} from "./workflow/planner-runtime.ts";
import type { WorkflowFinalReport } from "./workflow/report.ts";
import type { ExecutionMode, ModeDecision } from "./workflow/types.ts";
import type { WorkflowView } from "./workflow/view.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| AutonomousWorkflowEvent
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| {
			type: "workflow_mode_decided";
			decision: ModeDecision;
	  }
	| {
			type: "workflow_waiting_for_user";
			kind: "clarification" | "approval";
			workflowId?: string;
			questions?: readonly RequiredClarification[];
	  }
	| {
			type: "workflow_result";
			workflow: WorkflowView;
	  };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional Subagent Runtime override used by tests and embedders. */
	subagentRuntime?: SubagentRuntime;
	/** Optional background Job Runtime override used by tests and embedders. */
	jobRuntime?: JobRuntime;
	/** Optional read-only delivery Reviewer override used by tests and embedders. */
	deliveryReviewer?: ReadonlyReviewer;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface PendingWorkflowClarification {
	readonly requestText: string;
	readonly questions: readonly RequiredClarification[];
}

interface WorkflowModePreflight {
	readonly requestText: string;
	readonly decision: ModeDecision;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;
	private _workflowTrackingEnabled = false;
	private _workflowMode: ExecutionMode = "direct";
	private _workflowModeExplicit = false;
	private _workflowAutomationEnabled = false;
	private _autonomousWorkflowRunner: AutonomousWorkflowRunner | undefined;
	private _autonomousWorkflowId: string | undefined;
	private _latestWorkflowAutomationResult: WorkflowAutomationResult | undefined;
	private _pendingWorkflowClarification: PendingWorkflowClarification | undefined;
	/** The workflow adapter for the in-flight Direct workflow, if any. */
	private _activeWorkflowAdapter: AgentSessionAdapter | undefined;
	private _latestWorkflowReport: WorkflowFinalReport | undefined;
	private _latestWorkflowView: WorkflowView | undefined;
	private _planWorkflowRuntime: PlanWorkflowRuntime | undefined;
	private _subagentRuntime: SubagentRuntime | undefined;
	private _subagentTaskCompletions = new Map<string, Promise<AgentRunResult>>();
	private _jobRuntime: JobRuntime | undefined;
	private _jobTaskCompletions = new Map<string, Promise<Job>>();
	private _deliveryReviewer: ReadonlyReviewer | undefined;
	private _nextWorkflowMode: "direct" | "plan" = "direct";
	private _pendingPlanRevisionRequest: string | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._subagentRuntime = config.subagentRuntime;
		this._jobRuntime = config.jobRuntime;
		this._deliveryReviewer = config.deliveryReviewer;

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			return {
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			return result
				? { apiKey: result.auth.apiKey, headers: withoutDeletedHeaders(result.auth.headers), env: result.env }
				: {};
		} catch {
			return {};
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
				usage: result.usage,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
				usage: hookResult.usage,
			};
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this._autonomousWorkflowRunner?.stop();
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		void this._subagentRuntime?.dispose();
		this._subagentTaskCompletions.clear();
		const planWorkflowId = this._planWorkflowRuntime?.workflow.id;
		if (planWorkflowId) {
			void this._jobRuntime?.cancelWorkflow(planWorkflowId, "AgentSession disposed");
		}
		this._jobTaskCompletions.clear();
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/** Enable CLI Workflow creation for accepted top-level prompts. */
	enableWorkflowTracking(mode?: ExecutionMode, automationEnabled = false): void {
		this._workflowTrackingEnabled = true;
		this._workflowMode = mode ?? "direct";
		this._workflowModeExplicit = mode !== undefined;
		this._workflowAutomationEnabled = automationEnabled;
		this._recoverPendingWorkflowClarification();
		this._planWorkflowRuntime ??= PlanWorkflowRuntime.recoverLatest(this.sessionManager);
		if (
			this._workflowAutomationEnabled &&
			this._planWorkflowRuntime &&
			["executing", "verifying"].includes(this._planWorkflowRuntime.workflow.status)
		) {
			this._kickWorkflowAutomation();
		}
	}

	get workflowMode(): ExecutionMode {
		return this._workflowMode;
	}

	get workflowAutomationEnabled(): boolean {
		return this._workflowAutomationEnabled;
	}

	get workflowClarificationPending(): boolean {
		return this._pendingWorkflowClarification !== undefined;
	}

	setWorkflowMode(mode: ExecutionMode): void {
		this._workflowMode = mode;
		this._workflowModeExplicit = true;
		this._autonomousWorkflowRunner?.stop();
		this._autonomousWorkflowRunner = undefined;
		this._autonomousWorkflowId = undefined;
	}

	setWorkflowAutomationEnabled(enabled: boolean): void {
		this._workflowAutomationEnabled = enabled;
		this._autonomousWorkflowRunner?.stop();
		this._autonomousWorkflowRunner = undefined;
		this._autonomousWorkflowId = undefined;
		if (enabled) {
			this._kickWorkflowAutomation();
		}
	}

	async pumpWorkflow(): Promise<WorkflowAutomationResult | undefined> {
		const runtime = this._planWorkflowRuntime;
		if (!runtime || runtime.isTerminal) {
			return undefined;
		}
		const result = await this._getAutonomousWorkflowRunner(runtime).pump();
		this._latestWorkflowAutomationResult = result;
		return result;
	}

	async waitForWorkflowAutomation(): Promise<WorkflowAutomationResult | undefined> {
		const runtime = this._planWorkflowRuntime;
		if (!runtime || runtime.isTerminal || !this._workflowAutomationEnabled) {
			return undefined;
		}
		const result = await this._getAutonomousWorkflowRunner(runtime).pump();
		this._latestWorkflowAutomationResult = result;
		return result;
	}

	async submitWorkflowClarification(answer: string): Promise<void> {
		if (!this._pendingWorkflowClarification) {
			throw new Error("No Workflow clarification is awaiting an answer");
		}
		if (!answer.trim()) {
			throw new Error("Workflow clarification answer cannot be empty");
		}
		await this.prompt(answer, { expandPromptTemplates: false, source: "rpc" });
	}

	decideWorkflowPlan(action: "approve" | "reject" | "revise", comment: string): void {
		const runtime = this._planWorkflowRuntime;
		if (!runtime || runtime.workflow.status !== "awaiting_approval") {
			throw new Error("No Plan is awaiting a decision");
		}
		const normalizedComment = comment.trim();
		if (!normalizedComment) {
			throw new Error("Plan decision comment cannot be empty");
		}
		if (action === "approve") {
			runtime.approve(normalizedComment);
			this._kickWorkflowAutomation();
			return;
		}
		if (action === "reject") {
			runtime.reject(normalizedComment);
			return;
		}
		runtime.revise(normalizedComment);
		this._pendingPlanRevisionRequest = normalizedComment;
		this._nextWorkflowMode = "plan";
	}

	private _getAutonomousWorkflowRunner(runtime: PlanWorkflowRuntime): AutonomousWorkflowRunner {
		if (this._autonomousWorkflowRunner && this._autonomousWorkflowId === runtime.workflow.id) {
			return this._autonomousWorkflowRunner;
		}
		const maxConcurrency = Math.max(
			1,
			runtime.workflow.budget.maxConcurrentAgents ?? 4,
			runtime.workflow.budget.maxConcurrentJobs ?? 4,
		);
		this._autonomousWorkflowId = runtime.workflow.id;
		this._autonomousWorkflowRunner = new AutonomousWorkflowRunner({
			runtime,
			subagentRuntime: this._getSubagentRuntime(),
			jobRuntime: this._getJobRuntime(),
			deliveryRuntime: this._getDeliveryRuntime(),
			policy: createWorkflowAutomationPolicy(this._workflowMode, {
				enabled: this._workflowAutomationEnabled,
				maxConcurrency,
			}),
			onExecution: (execution) => this._trackWorkflowExecution(execution),
			onEvent: (event) => {
				this._emit(event);
				if (event.type === "workflow_automation_waiting" && event.reason === "terminal") {
					const workflow = this.getWorkflowView();
					if (workflow) {
						this._emit({ type: "workflow_result", workflow });
					}
				}
			},
		});
		return this._autonomousWorkflowRunner;
	}

	private _kickWorkflowAutomation(): void {
		const runtime = this._planWorkflowRuntime;
		if (!runtime || runtime.isTerminal || !this._workflowAutomationEnabled) {
			return;
		}
		void this._getAutonomousWorkflowRunner(runtime)
			.pump()
			.then((result) => {
				this._latestWorkflowAutomationResult = result;
			})
			.catch((error) => {
				if (!runtime.isTerminal) {
					runtime.failDelivery(
						`Workflow automation failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});
	}

	private _trackWorkflowExecution(execution: WorkflowTaskExecution): void {
		if (execution.subagent) {
			this._trackSubagentExecution(execution.subagent);
		}
		if (execution.job) {
			this._trackJobExecution(execution.job);
		}
	}

	private _appendWorkflowAutomationEntry(data: unknown): void {
		const entryId = this.sessionManager.appendCustomEntry("workflow-automation", data);
		const entry = this.sessionManager.getEntry(entryId);
		if (entry) {
			this._emit({ type: "entry_appended", entry });
		}
	}

	private _recoverPendingWorkflowClarification(): void {
		let pending: PendingWorkflowClarification | undefined;
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "workflow-automation") {
				continue;
			}
			const data = entry.data;
			if (typeof data !== "object" || data === null || !("kind" in data)) {
				continue;
			}
			if (data.kind === "clarification_answered") {
				pending = undefined;
				continue;
			}
			if (
				data.kind !== "clarification_requested" ||
				!("requestText" in data) ||
				typeof data.requestText !== "string" ||
				!("questions" in data) ||
				!Array.isArray(data.questions)
			) {
				continue;
			}
			pending = {
				requestText: data.requestText,
				questions: structuredClone(data.questions) as RequiredClarification[],
			};
		}
		this._pendingWorkflowClarification = pending;
	}

	private _showWorkflowAutomationMessage(lines: readonly string[]): void {
		const message = {
			role: "custom" as const,
			customType: "workflow",
			content: lines.join("\n"),
			display: true,
			details: {
				workflow: this.getWorkflowView(),
			},
			timestamp: Date.now(),
		} satisfies CustomMessage<{ readonly workflow: WorkflowView | undefined }>;
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/**
	 * Cancel the in-flight Direct workflow, if any.
	 *
	 * Drives the two-phase cancellation flow (request → abort → finalize) and
	 * resolves once the AgentSession is idle and the workflow is terminal.
	 * Returns false when there is no active workflow to cancel.
	 */
	async cancelWorkflow(reason = "User cancelled the workflow"): Promise<boolean> {
		this._autonomousWorkflowRunner?.stop();
		const adapter = this._activeWorkflowAdapter;
		if (adapter && !adapter.finalReport) {
			await adapter.cancel(reason);
			const finalReport = adapter.finalReport;
			if (finalReport) {
				this._latestWorkflowReport = finalReport;
			}
			const view = adapter.view;
			if (view) {
				this._latestWorkflowView = view;
			}
			return true;
		}
		const planRuntime = this._planWorkflowRuntime;
		if (planRuntime && !planRuntime.isTerminal) {
			await planRuntime.cancel(reason, this._subagentRuntime, this._jobRuntime);
			return true;
		}
		return false;
	}

	async upgradeDirectWorkflowToPlan(reason: string): Promise<boolean> {
		const adapter = this._activeWorkflowAdapter;
		const view = adapter?.view;
		if (!adapter || !view || view.workflow.status !== "executing") {
			return false;
		}
		const decision = decideDirectPlanUpgrade(
			{
				complexity: "high",
				riskLevel: "medium",
				confidence: "low",
				reason,
			},
			new Date().toISOString(),
		);
		if (decision.action !== "upgrade_to_plan") {
			return false;
		}
		await adapter.upgradeToPlan(decision);
		const runtime = PlanWorkflowRuntime.recoverLatest(this.sessionManager, {}, view.workflow.id);
		if (!runtime || runtime.workflow.status !== "planning") {
			throw new Error(`Direct Workflow ${view.workflow.id} did not recover in Planning state`);
		}
		this._planWorkflowRuntime = runtime;
		this._pendingPlanRevisionRequest = [
			`Direct-to-Plan upgrade: ${reason}`,
			`Existing changed files: ${view.workflow.result?.changedFiles.join(", ") || "(see Workflow task modifications)"}`,
		].join("\n");
		await this._runPlannerWorkflow(runtime.workflow.request.text);
		return true;
	}

	/** Return the latest terminal Direct Workflow report for this AgentSession. */
	getLatestWorkflowReport(): WorkflowFinalReport | undefined {
		return this._latestWorkflowReport ? structuredClone(this._latestWorkflowReport) : undefined;
	}

	/** Return a serializable, UI-independent view of the current or latest Workflow. */
	getWorkflowView(): WorkflowView | undefined {
		const active = this._activeWorkflowAdapter?.view;
		if (active) {
			return this._withWorkflowAutomation(active);
		}
		const planRuntime = this._planWorkflowRuntime;
		if (planRuntime) {
			const workflowId = planRuntime.workflow.id;
			return this._withWorkflowAutomation(
				planRuntime.view(this._subagentRuntime?.list(workflowId) ?? [], this._jobRuntime?.jobs(workflowId) ?? []),
			);
		}
		return this._latestWorkflowView ? this._withWorkflowAutomation(this._latestWorkflowView) : undefined;
	}

	private _withWorkflowAutomation(view: WorkflowView): WorkflowView {
		const waitingReason =
			this._latestWorkflowAutomationResult?.workflowId === view.workflow.id
				? this._latestWorkflowAutomationResult.waitingReason
				: undefined;
		const automationStatus = this._workflowAutomationEnabled
			? `automation:${this._autonomousWorkflowRunner?.isRunning ? "running" : (waitingReason ?? "idle")}`
			: "automation:off";
		return {
			...structuredClone(view),
			statusLine: `${view.statusLine} | mode:${this._workflowMode} | ${automationStatus}`,
			automation: {
				enabled: this._workflowAutomationEnabled,
				mode: this._workflowMode,
				running: this._autonomousWorkflowRunner?.isRunning ?? false,
				waitingReason,
			},
		};
	}

	/** Return the current or latest authoritative Workflow status line for CLI presentation. */
	getWorkflowStatusLine(): string | undefined {
		return this.getWorkflowView()?.statusLine ?? this._latestWorkflowReport?.statusLine;
	}

	/** Return the current or latest Workflow summary rendered by `/workflow`. */
	getWorkflowReportLines(): readonly string[] | undefined {
		const lines = this.getWorkflowView()?.reportLines ?? this._latestWorkflowReport?.lines;
		return lines ? [...lines] : undefined;
	}

	private _getSubagentRuntime(): SubagentRuntime {
		this._subagentRuntime ??= new SubagentRuntime({
			sessionFactory: new RpcSubagentSessionFactory(),
		});
		return this._subagentRuntime;
	}

	private _trackSubagentExecution(execution: SubagentTaskExecution): void {
		this._subagentTaskCompletions.set(execution.agent.id, execution.completion);
		void execution.completion
			.catch(() => undefined)
			.finally(() => {
				this._kickWorkflowAutomation();
			});
	}

	private _getJobRuntime(): JobRuntime {
		this._jobRuntime ??= new JobRuntime({
			processFactory: new LocalJobProcessFactory({
				shellPath: this.settingsManager.getShellPath(),
			}),
			maxConcurrentJobs: this._planWorkflowRuntime?.workflow.budget.maxConcurrentJobs ?? 4,
		});
		return this._jobRuntime;
	}

	private _getDeliveryRuntime(): DeliveryRuntime {
		const subagentRuntime = this._getSubagentRuntime();
		this._deliveryReviewer ??= new SubagentReadonlyReviewer(subagentRuntime);
		return new DeliveryRuntime({
			jobRuntime: this._getJobRuntime(),
			reviewer: this._deliveryReviewer,
		});
	}

	private _trackJobExecution(execution: JobTaskExecution): void {
		this._jobTaskCompletions.set(execution.job.id, execution.completion);
		void execution.completion
			.catch(() => undefined)
			.finally(() => {
				this._kickWorkflowAutomation();
			});
	}

	private async _preflightWorkflowMode(requestText: string): Promise<WorkflowModePreflight | undefined> {
		let effectiveRequestText = requestText;
		let clarificationContext: string | undefined;
		if (this._pendingWorkflowClarification) {
			const pending = this._pendingWorkflowClarification;
			clarificationContext = [
				"Questions:",
				...pending.questions.map(({ id, question }) => `${id}: ${question}`),
				"",
				`User answer: ${requestText}`,
			].join("\n");
			effectiveRequestText = `${pending.requestText}\n\nClarification answer:\n${requestText}`;
			this._appendWorkflowAutomationEntry({
				kind: "clarification_answered",
				requestText: pending.requestText,
				answer: requestText,
				answeredAt: new Date().toISOString(),
			});
			this._pendingWorkflowClarification = undefined;
		}

		const decidedAt = new Date().toISOString();
		if (this._nextWorkflowMode === "plan" || this._workflowMode === "plan") {
			const decision = createModeDecision({
				selection: selectExecutionMode({ requestedMode: "plan" }),
				reason: "User explicitly selected Plan mode",
				riskLevel: "low",
				decidedAt,
			});
			this._emit({ type: "workflow_mode_decided", decision });
			return { requestText: effectiveRequestText, decision };
		}
		if (requiresPlanMode({ text: effectiveRequestText })) {
			const decision = createModeDecision({
				selection: selectExecutionMode({ forcePlan: true }),
				reason:
					"Safety policy requires Plan mode for destructive, release, migration, or permission-sensitive work",
				riskLevel: "high",
				decidedAt,
			});
			this._emit({ type: "workflow_mode_decided", decision });
			return { requestText: effectiveRequestText, decision };
		}
		if (this._workflowMode === "direct") {
			const explicitlySelected = this._workflowModeExplicit;
			const decision = createModeDecision({
				selection: selectExecutionMode({ requestedMode: explicitlySelected ? "direct" : undefined }),
				reason: explicitlySelected
					? "User explicitly selected Direct mode"
					: "No explicit mode or Agent recommendation was available; using the Direct default",
				riskLevel: "low",
				decidedAt,
			});
			this._emit({ type: "workflow_mode_decided", decision });
			return { requestText: effectiveRequestText, decision };
		}

		try {
			const envelope = createModeAdvisorPromptEnvelope({
				createdAt: decidedAt,
				requestText: effectiveRequestText,
				clarificationContext,
			});
			await executeModeAdvisorPrompt(this, envelope);
			const message = this._findLastAssistantMessage();
			if (!message) {
				throw new Error("Mode Advisor completed without an Assistant message");
			}
			const result = parseModeAdvisorResult(contentText(message.content, ""));
			if (result.clarification.required) {
				const pending = {
					requestText: effectiveRequestText,
					questions: result.clarification.questions,
				} satisfies PendingWorkflowClarification;
				this._pendingWorkflowClarification = pending;
				this._appendWorkflowAutomationEntry({
					kind: "clarification_requested",
					requestText: pending.requestText,
					questions: pending.questions,
					requestedAt: decidedAt,
				});
				this._emit({
					type: "workflow_waiting_for_user",
					kind: "clarification",
					questions: pending.questions,
				});
				this._showWorkflowAutomationMessage([
					"Workflow requires clarification:",
					...pending.questions.map(({ id, question }) => `- ${id}: ${question}`),
					"Reply with the missing information to continue.",
				]);
				return undefined;
			}
			if (result.clarification.assumptions.length > 0) {
				effectiveRequestText = [
					effectiveRequestText,
					"",
					"Safe assumptions selected during Workflow preflight:",
					...result.clarification.assumptions.map(({ id, answer, reason }) => `- ${id}: ${answer} (${reason})`),
				].join("\n");
			}
			const decision = createModeDecision({
				selection: selectExecutionMode({ agentAdvice: result.advice }),
				reason: result.advice.reason,
				riskLevel: result.advice.riskLevel,
				decidedAt,
			});
			this._emit({ type: "workflow_mode_decided", decision });
			return { requestText: effectiveRequestText, decision };
		} catch (error) {
			const decision = createModeDecision({
				selection: selectExecutionMode({ forcePlan: true }),
				reason: `Mode Advisor unavailable; conservatively selected Plan: ${
					error instanceof Error ? error.message : String(error)
				}`,
				riskLevel: "medium",
				decidedAt,
			});
			this._emit({ type: "workflow_mode_decided", decision });
			return { requestText: effectiveRequestText, decision };
		}
	}

	private async _runPlannerWorkflow(requestText: string, modeDecision?: ModeDecision): Promise<void> {
		let runtime = this._planWorkflowRuntime;
		if (!runtime || runtime.isTerminal || runtime.workflow.status !== "planning") {
			runtime = PlanWorkflowRuntime.start(this.sessionManager, {
				request: {
					text: requestText,
					cwd: this._cwd,
					requestedMode: "plan",
					attachments: [],
				},
				modeDecision,
			});
			this._planWorkflowRuntime = runtime;
			this._autonomousWorkflowRunner = undefined;
			this._autonomousWorkflowId = undefined;
		}
		const workflow = runtime.workflow;
		const rootTask = runtime.tasks.find(({ id }) => id === workflow.rootTaskId);
		if (!rootTask) {
			throw new Error(`Plan Workflow ${workflow.id} has no root Task`);
		}
		const currentPlan = runtime.currentPlan;
		const envelope = createPlannerPromptEnvelope({
			createdAt: new Date().toISOString(),
			task: rootTask,
			userRequest: workflow.request.text,
			activeToolNames: this.getActiveToolNames(),
			currentPlan: currentPlan.version > 1 ? currentPlan : undefined,
			revisionRequest: this._pendingPlanRevisionRequest
				? `${this._pendingPlanRevisionRequest}\n\nUser refinement: ${requestText}`
				: undefined,
		});
		await executePlannerPrompt(this, envelope);
		const message = this._findLastAssistantMessage();
		if (!message) {
			throw new Error("Planner completed without an Assistant message");
		}
		runtime.submit(parsePlannerPlanContent(contentText(message.content, "")));
		this._pendingPlanRevisionRequest = undefined;
		this._nextWorkflowMode = "direct";
		this._emit({
			type: "workflow_waiting_for_user",
			kind: "approval",
			workflowId: runtime.workflow.id,
		});
	}

	private _startDirectWorkflow(requestText: string, modeDecision?: ModeDecision): AgentSessionAdapter {
		if (this._planWorkflowRuntime?.isTerminal) {
			this._planWorkflowRuntime = undefined;
		}
		return startDirectAgentSessionWorkflow(this, {
			commandId: `command-${randomUUID()}`,
			workflowId: `workflow-${randomUUID()}`,
			rootTaskId: `task-${randomUUID()}`,
			request: {
				text: requestText,
				cwd: this._cwd,
				requestedMode: modeDecision?.source === "user" ? "direct" : undefined,
				attachments: [],
			},
			modeDecision,
		});
	}

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[], emitSettled = true): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			if (emitSettled) {
				await this._emitAgentSettled();
			} else {
				this._isAgentRunActive = false;
				this._resolveIdleWaitIfIdle();
			}
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;
		let directRequestText: string | undefined;
		let directModeDecision: ModeDecision | undefined;
		let workflowAdapter: AgentSessionAdapter | undefined;

		try {
			if (expandPromptTemplates && text.startsWith("/") && (await this._tryExecuteWorkflowCommand(text))) {
				preflightResult?.(true);
				return;
			}

			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}
			if (this._workflowTrackingEnabled && (options?.source ?? "interactive") !== "extension" && !this.isStreaming) {
				const activePlan = this._planWorkflowRuntime;
				if (
					activePlan &&
					!activePlan.isTerminal &&
					activePlan.workflow.status !== "planning" &&
					this._pendingWorkflowClarification === undefined
				) {
					throw new Error(
						`Plan Workflow ${activePlan.workflow.id} is ${activePlan.workflow.status}; approve, revise, reject, or cancel it before starting another request`,
					);
				}
				const preflight = await this._preflightWorkflowMode(currentText);
				if (!preflight) {
					await this._emitAgentSettled();
					preflightResult?.(true);
					return;
				}
				currentText = preflight.requestText;
				if (preflight.decision.mode === "plan") {
					await this._runPlannerWorkflow(currentText, preflight.decision);
					await this._emitAgentSettled();
					preflightResult?.(true);
					return;
				}
				directRequestText = currentText;
				directModeDecision = preflight.decision;
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}

			if (directRequestText !== undefined) {
				workflowAdapter = this._startDirectWorkflow(directRequestText, directModeDecision);
				this._activeWorkflowAdapter = workflowAdapter;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		try {
			await this._runAgentPrompt(messages, (options?.source ?? "interactive") !== "extension");
		} finally {
			const finalReport = workflowAdapter?.finalReport;
			if (finalReport) {
				this._latestWorkflowReport = finalReport;
			}
			const view = workflowAdapter?.view;
			if (view) {
				this._latestWorkflowView = view;
			}
			if (this._activeWorkflowAdapter === workflowAdapter) {
				this._activeWorkflowAdapter = undefined;
			}
			workflowAdapter?.dispose();
		}
	}

	/** Execute built-in Workflow commands without sending them to the model. */
	private async _tryExecuteWorkflowCommand(text: string): Promise<boolean> {
		if (!this._workflowTrackingEnabled) {
			return false;
		}
		const [commandName, ...args] = text.trim().split(/\s+/);
		if (
			commandName !== "/workflow" &&
			commandName !== "/cancel" &&
			commandName !== "/workflow-cancel" &&
			commandName !== "/plan" &&
			commandName !== "/direct" &&
			commandName !== "/auto" &&
			commandName !== "/workflow-auto" &&
			commandName !== "/workflow-pump" &&
			commandName !== "/upgrade-plan" &&
			commandName !== "/approve" &&
			commandName !== "/reject" &&
			commandName !== "/replan" &&
			commandName !== "/tasks" &&
			commandName !== "/task" &&
			commandName !== "/agents" &&
			commandName !== "/agent" &&
			commandName !== "/jobs" &&
			commandName !== "/job" &&
			commandName !== "/verify" &&
			commandName !== "/workflow-resume"
		) {
			return false;
		}

		let lines: readonly string[];
		if (
			(commandName === "/workflow" ||
				commandName === "/plan" ||
				commandName === "/direct" ||
				commandName === "/auto" ||
				commandName === "/tasks" ||
				commandName === "/workflow-pump") &&
			args.length > 0
		) {
			lines = [`Usage: ${commandName}`];
		} else if (commandName === "/workflow-cancel" && args.length > 0) {
			lines = ["Usage: /workflow-cancel"];
		} else if (commandName === "/workflow-cancel" || commandName === "/cancel") {
			const cancelled = await this.cancelWorkflow(args.join(" ") || "Cancelled by user");
			lines = cancelled
				? (this.getWorkflowReportLines() ?? ["Workflow cancellation completed."])
				: ["No active Workflow to cancel."];
		} else if (commandName === "/plan") {
			const runtime = this._planWorkflowRuntime;
			if (runtime && !runtime.isTerminal) {
				lines = runtime.statusLines;
			} else {
				this._nextWorkflowMode = "plan";
				lines = ["Plan mode selected. The next request will run the read-only Planner."];
			}
		} else if (commandName === "/direct") {
			this.setWorkflowMode("direct");
			lines = ["Workflow mode set to Direct."];
		} else if (commandName === "/auto") {
			this.setWorkflowMode("auto");
			lines = ["Workflow mode set to Auto."];
		} else if (commandName === "/workflow-auto") {
			const setting = args[0];
			if (args.length !== 1 || (setting !== "on" && setting !== "off")) {
				lines = ["Usage: /workflow-auto on|off"];
			} else {
				this.setWorkflowAutomationEnabled(setting === "on");
				lines = [`Workflow automation ${setting === "on" ? "enabled" : "disabled"}.`];
			}
		} else if (commandName === "/workflow-pump") {
			const result = await this.pumpWorkflow();
			lines = result
				? [
						`Workflow pump: ${result.status}`,
						`Actions: ${result.actions.length}`,
						`Waiting: ${result.waitingReason ?? "(none)"}`,
					]
				: ["No active Plan Workflow can be advanced."];
		} else if (commandName === "/upgrade-plan") {
			const upgraded = await this.upgradeDirectWorkflowToPlan(
				args.join(" ") || "Direct execution discovered complexity requiring Plan mode",
			);
			lines = upgraded
				? (this._planWorkflowRuntime?.statusLines ?? ["Direct Workflow upgraded to Plan."])
				: ["No executing Direct Workflow can be upgraded."];
		} else if (commandName === "/approve") {
			const runtime = this._planWorkflowRuntime;
			if (!runtime || runtime.workflow.status !== "awaiting_approval") {
				lines = ["No Plan is awaiting approval."];
			} else {
				runtime.approve(args.join(" ") || "Approved by user");
				lines = runtime.statusLines;
				this._kickWorkflowAutomation();
			}
		} else if (commandName === "/reject") {
			const runtime = this._planWorkflowRuntime;
			if (!runtime || runtime.workflow.status !== "awaiting_approval") {
				lines = ["No Plan is awaiting approval."];
			} else {
				runtime.reject(args.join(" ") || "Rejected by user");
				lines = runtime.statusLines;
			}
		} else if (commandName === "/replan") {
			const runtime = this._planWorkflowRuntime;
			if (!runtime || runtime.workflow.status !== "awaiting_approval") {
				lines = ["No Plan is awaiting revision."];
			} else {
				const revisionRequest = args.join(" ") || "Revise the Plan";
				runtime.revise(revisionRequest);
				this._pendingPlanRevisionRequest = revisionRequest;
				this._nextWorkflowMode = "plan";
				lines = [
					...runtime.statusLines,
					"Send the refinement details to run the read-only Planner for this version.",
				];
			}
		} else if (commandName === "/tasks") {
			const runtime = this._planWorkflowRuntime;
			if (!runtime) {
				lines = ["No Plan Workflow exists."];
			} else {
				if (runtime.workflow.status === "executing") {
					runtime.refreshTaskReadiness();
				}
				const maxConcurrency = Math.max(1, runtime.workflow.budget.maxConcurrentAgents ?? 4);
				const dispatches = runtime.workflow.status === "executing" ? runtime.selectDispatches(maxConcurrency) : [];
				lines = [
					`Tasks | ${runtime.workflow.status} | ${runtime.progress.succeededSteps}/${runtime.progress.totalSteps} steps`,
					runtime.budgetStatusLine,
					runtime.writerLeaseStatusLine,
					...runtime.taskTreeLines,
					`Dispatchable: ${dispatches.length > 0 ? dispatches.map(({ taskId }) => taskId).join(", ") : "(none)"}`,
				];
			}
		} else if (commandName === "/task") {
			const runtime = this._planWorkflowRuntime;
			const [action, taskId, ...detailParts] = args;
			if (!runtime) {
				lines = ["No Plan Workflow exists."];
			} else if (!action || !taskId || !["show", "retry", "cancel"].includes(action)) {
				lines = ["Usage: /task show <id> | /task retry <id> | /task cancel <id> [reason]"];
			} else if (action === "show") {
				lines = runtime.taskDetails(taskId);
			} else if (runtime.workflow.status !== "executing") {
				lines = [`Plan Workflow is ${runtime.workflow.status}; Task mutation is unavailable.`];
			} else if (action === "retry") {
				runtime.retryTask(taskId);
				lines = runtime.taskDetails(taskId);
				this._kickWorkflowAutomation();
			} else {
				runtime.cancelTask(taskId, detailParts.join(" ") || "Cancelled by user");
				runtime.refreshTaskReadiness();
				lines = runtime.taskDetails(taskId);
			}
		} else if (commandName === "/agents") {
			const planRuntime = this._planWorkflowRuntime;
			if (!planRuntime) {
				lines = ["No Plan Workflow exists."];
			} else if (args.length === 0) {
				lines = formatAgentList(this._subagentRuntime?.list(planRuntime.workflow.id) ?? []);
			} else if (planRuntime.workflow.status !== "executing") {
				lines = [`Plan Workflow is ${planRuntime.workflow.status}; Agent dispatch is unavailable.`];
			} else if (args[0] === "dispatch" && args.length <= 2) {
				const fallback = Math.max(1, planRuntime.workflow.budget.maxConcurrentAgents ?? 4);
				const requested = args[1] === undefined ? fallback : Number(args[1]);
				if (!Number.isInteger(requested) || requested < 1) {
					lines = ["Usage: /agents dispatch [max-concurrency]"];
				} else if (this._workflowAutomationEnabled) {
					const result = await this.pumpWorkflow();
					lines = [
						`Automatic Workflow pump requested; ${result?.actions.length ?? 0} action(s) observed.`,
						...formatAgentList(this._subagentRuntime?.list(planRuntime.workflow.id) ?? []),
					];
				} else {
					const subagentRuntime = this._getSubagentRuntime();
					const executions = await planRuntime.startReadySubagents(subagentRuntime, requested);
					for (const execution of executions) {
						this._trackSubagentExecution(execution);
					}
					lines = [
						`Dispatched ${executions.length} Subagent${executions.length === 1 ? "" : "s"}.`,
						...formatAgentList(subagentRuntime.list(planRuntime.workflow.id)),
					];
				}
			} else {
				lines = ["Usage: /agents | /agents dispatch [max-concurrency]"];
			}
		} else if (commandName === "/agent") {
			const planRuntime = this._planWorkflowRuntime;
			const [action, agentOrTaskId, ...detailParts] = args;
			if (!planRuntime) {
				lines = ["No Plan Workflow exists."];
			} else if (!action || !agentOrTaskId) {
				lines = [
					"Usage: /agent spawn <task-id> [explorer|worker|reviewer] | /agent show <agent-id> | /agent send <agent-id> <message> | /agent wait <agent-id> | /agent interrupt <agent-id> [reason] | /agent retry <agent-id>",
				];
			} else {
				const subagentRuntime = this._getSubagentRuntime();
				if (action === "spawn") {
					const role = detailParts[0];
					const profileRole = role === "explorer" || role === "worker" || role === "reviewer" ? role : undefined;
					if (detailParts.length > 1 || (role !== undefined && profileRole === undefined)) {
						lines = ["Usage: /agent spawn <task-id> [explorer|worker|reviewer]"];
					} else {
						const execution = await planRuntime.startSubagentTask(subagentRuntime, agentOrTaskId, {
							profileRole,
						});
						this._trackSubagentExecution(execution);
						lines = formatAgentList([execution.agent]);
					}
				} else if (action === "show" && detailParts.length === 0) {
					const agent = subagentRuntime.registry.get(agentOrTaskId);
					if (!agent) {
						lines = [`Agent ${agentOrTaskId} does not exist.`];
					} else {
						const handoff = agent.handoffId ? subagentRuntime.registry.getHandoff(agent.handoffId) : undefined;
						lines = formatAgentDetails(
							agent,
							handoff,
							formatAgentEvents(subagentRuntime.registry.events(agent.id)),
						);
					}
				} else if (action === "send" && detailParts.length > 0) {
					await subagentRuntime.send(agentOrTaskId, detailParts.join(" "));
					const updatedAgent = subagentRuntime.registry.get(agentOrTaskId);
					lines = updatedAgent ? formatAgentList([updatedAgent]) : [`Agent ${agentOrTaskId} does not exist.`];
				} else if (action === "wait" && detailParts.length === 0) {
					const completion = this._subagentTaskCompletions.get(agentOrTaskId);
					lines = formatAgentRunResult(completion ? await completion : await subagentRuntime.wait(agentOrTaskId));
				} else if (action === "interrupt") {
					const result = await subagentRuntime.interrupt(
						agentOrTaskId,
						detailParts.join(" ") || "Interrupted by user",
					);
					const completion = this._subagentTaskCompletions.get(agentOrTaskId);
					lines = formatAgentRunResult(completion ? await completion : result);
				} else if (action === "retry" && detailParts.length === 0) {
					const source = subagentRuntime.registry.get(agentOrTaskId);
					if (!source) {
						lines = [`Agent ${agentOrTaskId} does not exist.`];
					} else {
						const execution = await planRuntime.startSubagentTask(subagentRuntime, source.taskId, {
							retryAgentId: source.id,
						});
						this._trackSubagentExecution(execution);
						lines = formatAgentList([execution.agent]);
					}
				} else {
					lines = [
						"Usage: /agent spawn <task-id> [explorer|worker|reviewer] | /agent show <agent-id> | /agent send <agent-id> <message> | /agent wait <agent-id> | /agent interrupt <agent-id> [reason] | /agent retry <agent-id>",
					];
				}
			}
		} else if (commandName === "/jobs") {
			const planRuntime = this._planWorkflowRuntime;
			if (!planRuntime) {
				lines = ["No Plan Workflow exists."];
			} else if (args.length === 0) {
				lines = formatJobs(this._jobRuntime?.jobs(planRuntime.workflow.id) ?? []);
			} else if (planRuntime.workflow.status !== "executing") {
				lines = [`Plan Workflow is ${planRuntime.workflow.status}; Job dispatch is unavailable.`];
			} else if (args[0] === "dispatch" && args.length <= 2) {
				const fallback = Math.max(1, planRuntime.workflow.budget.maxConcurrentJobs ?? 4);
				const requested = args[1] === undefined ? fallback : Number(args[1]);
				if (!Number.isInteger(requested) || requested < 1) {
					lines = ["Usage: /jobs dispatch [max-concurrency]"];
				} else if (this._workflowAutomationEnabled) {
					const result = await this.pumpWorkflow();
					lines = [
						`Automatic Workflow pump requested; ${result?.actions.length ?? 0} action(s) observed.`,
						...formatJobs(this._jobRuntime?.jobs(planRuntime.workflow.id) ?? []),
					];
				} else {
					const jobRuntime = this._getJobRuntime();
					const executions = await planRuntime.startReadyJobs(jobRuntime, requested);
					for (const execution of executions) {
						this._trackJobExecution(execution);
					}
					lines = [
						`Dispatched ${executions.length} Job${executions.length === 1 ? "" : "s"}.`,
						...formatJobs(jobRuntime.jobs(planRuntime.workflow.id)),
					];
				}
			} else {
				lines = ["Usage: /jobs | /jobs dispatch [max-concurrency]"];
			}
		} else if (commandName === "/job") {
			const [action, jobOrTaskId, ...detailParts] = args;
			const planRuntime = this._planWorkflowRuntime;
			if (!planRuntime) {
				lines = ["No Plan Workflow exists."];
			} else if (!action || !jobOrTaskId) {
				lines = [
					"Usage: /job run <task-id> | /job show <job-id> | /job logs <job-id> [after-sequence] | /job wait <job-id> | /job kill <job-id> [reason]",
				];
			} else {
				const jobRuntime = this._getJobRuntime();
				const existingJob = action === "run" ? undefined : jobRuntime.registry.get(jobOrTaskId);
				if (action === "run" && detailParts.length === 0) {
					const execution = await planRuntime.startJobTask(jobRuntime, jobOrTaskId);
					this._trackJobExecution(execution);
					lines = [formatJob(execution.job)];
				} else if (action !== "run" && !existingJob) {
					lines = [`Job ${jobOrTaskId} does not exist.`];
				} else if (action === "show" && detailParts.length === 0) {
					lines = existingJob ? [formatJob(existingJob)] : [`Job ${jobOrTaskId} does not exist.`];
				} else if (action === "logs" && detailParts.length <= 1) {
					const afterSequence = detailParts[0] === undefined ? 0 : Number(detailParts[0]);
					lines =
						!Number.isInteger(afterSequence) || afterSequence < 0
							? ["Usage: /job logs <job-id> [after-sequence]"]
							: formatJobLogs(jobRuntime.logs(jobOrTaskId, afterSequence));
				} else if (action === "wait" && detailParts.length === 0) {
					const completion = this._jobTaskCompletions.get(jobOrTaskId);
					lines = [formatJob(completion ? await completion : await jobRuntime.wait(jobOrTaskId))];
				} else if (action === "kill") {
					await jobRuntime.kill(jobOrTaskId, detailParts.join(" ") || "Killed by user");
					const completion = this._jobTaskCompletions.get(jobOrTaskId);
					const job = completion ? await completion : jobRuntime.registry.get(jobOrTaskId);
					const finalJob = job ?? existingJob;
					lines = finalJob ? [formatJob(finalJob)] : [`Job ${jobOrTaskId} does not exist.`];
				} else {
					lines = [
						"Usage: /job run <task-id> | /job show <job-id> | /job logs <job-id> [after-sequence] | /job wait <job-id> | /job kill <job-id> [reason]",
					];
				}
			}
		} else if (commandName === "/verify") {
			const runtime = this._planWorkflowRuntime;
			const hasIncompleteTasks = runtime?.tasks.some(
				({ kind, status }) => kind !== "control" && status !== "succeeded",
			);
			if (args.length > 0) {
				lines = ["Usage: /verify"];
			} else if (!runtime || (runtime.workflow.status !== "executing" && runtime.workflow.status !== "verifying")) {
				lines = ["No Plan Workflow is ready for delivery verification."];
			} else if (hasIncompleteTasks) {
				lines = ["Delivery verification requires every executable Task to succeed first."];
			} else if (this._workflowAutomationEnabled) {
				const result = await this.pumpWorkflow();
				lines = result ? runtime.statusLines : ["No Plan Workflow is ready for delivery verification."];
			} else {
				const result = await this._getDeliveryRuntime().run(runtime);
				lines =
					result.status === "repair_created" && result.repairTask
						? [
								`Delivery verification failed; Repair Task ${result.repairTask.id} created.`,
								...runtime.taskDetails(result.repairTask.id),
							]
						: runtime.statusLines;
			}
		} else if (commandName === "/workflow-resume") {
			const [action, id, ...detailParts] = args;
			if (!action || action === "list") {
				const workflows = PlanWorkflowRuntime.list(this.sessionManager).filter(
					({ modeDecision, currentPlanId }) => modeDecision?.mode === "plan" || currentPlanId !== undefined,
				);
				lines =
					workflows.length === 0
						? ["No persisted Plan Workflows."]
						: workflows.map(
								({ id: workflowId, status, updatedAt }) => `${workflowId} | ${status} | ${updatedAt}`,
							);
			} else if (action === "continue" && detailParts.length === 0) {
				const current = this._planWorkflowRuntime;
				if (current && !current.isTerminal && (!id || id === current.workflow.id)) {
					lines = current.statusLines;
				} else if (current && !current.isTerminal) {
					lines = [`Workflow ${current.workflow.id} is active; cancel it before resuming another Workflow.`];
				} else {
					const recovered = PlanWorkflowRuntime.recoverLatest(this.sessionManager, {}, id);
					if (!recovered) {
						lines = [id ? `Workflow ${id} does not exist.` : "No Plan Workflow can be resumed."];
					} else {
						this._planWorkflowRuntime = recovered;
						lines = recovered.statusLines;
						this._kickWorkflowAutomation();
					}
				}
			} else if (action === "retry" && id && detailParts.length === 0) {
				const runtime = this._planWorkflowRuntime;
				if (!runtime || runtime.workflow.status !== "executing") {
					lines = ["No resumed Plan Workflow is executing."];
				} else {
					runtime.retryTask(id);
					lines = runtime.taskDetails(id);
					this._kickWorkflowAutomation();
				}
			} else if (action === "cancel" && detailParts.length === 0) {
				const current = this._planWorkflowRuntime;
				const runtime =
					current && (!id || current.workflow.id === id)
						? current
						: current && !current.isTerminal
							? undefined
							: PlanWorkflowRuntime.recoverLatest(this.sessionManager, {}, id);
				if (current && !current.isTerminal && id && current.workflow.id !== id) {
					lines = [`Workflow ${current.workflow.id} is active; cancel it before cancelling another Workflow.`];
				} else if (!runtime || runtime.isTerminal) {
					lines = ["No resumable Plan Workflow can be cancelled."];
				} else {
					this._planWorkflowRuntime = runtime;
					await runtime.cancel("Cancelled during Workflow recovery", this._subagentRuntime, this._jobRuntime);
					lines = runtime.statusLines;
				}
			} else {
				lines = [
					"Usage: /workflow-resume list | /workflow-resume continue [workflow-id] | /workflow-resume retry <task-id> | /workflow-resume cancel [workflow-id]",
				];
			}
		} else {
			lines = this.getWorkflowReportLines() ?? ["No Workflow has been created in this session."];
		}

		const message = {
			role: "custom" as const,
			customType: "workflow",
			content: lines.join("\n"),
			display: true,
			details: {
				command: commandName,
				statusLine: this.getWorkflowStatusLine(),
				workflow: this.getWorkflowView(),
			},
			timestamp: Date.now(),
		} satisfies CustomMessage<{
			readonly command: string;
			readonly statusLine: string | undefined;
			readonly workflow: WorkflowView | undefined;
		}>;
		// Workflow command output is presentation-only: do not persist it or add it
		// to Agent state, because a status query must never become model context.
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
		return true;
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const checks = await Promise.all(
			this._scopedModels.map(async (scoped) => ({
				scoped,
				auth: await this._modelRuntime.checkAuth(scoped.model.provider),
			})),
		);
		const scopedModels = checks.filter(({ auth }) => auth !== undefined).map(({ scoped }) => scoped);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRuntime.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._disconnectFromAgent();
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason: "manual" }),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error, or reported usage exceeded
		// the configured window. A successful response over the configured window should compact
		// but must not retry: the assistant answer already completed and agent.continue() cannot
		// continue from an assistant message.
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;

		try {
			if (!this.model) {
				return false;
			}

			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			let env: Record<string, string> | undefined;
			if (this.agent.streamFunction === streamSimple) {
				({ apiKey, headers, env } = await this._getRequiredRequestAuth(this.model));
			} else {
				({ apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model));
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: this._bashAbortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
