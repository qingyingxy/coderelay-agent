import type { AgentToolResult, StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { MAX_HANDOFF_BYTES, TARGET_HANDOFF_BYTES } from "../../src/core/workflow/context-handoff.ts";

export const MAX_MAINTENANCE_REQUESTS = 3;
export const MAINTENANCE_PROMPT = `Maintain historical requirements for later continuation. Complete one successful context-window cut using new_context. Supply a concise factual handoff of at most ${MAX_HANDOFF_BYTES} UTF-8 bytes, not characters; aim for about ${TARGET_HANDOFF_BYTES} bytes. Preserve unresolved work, constraints and next action; leave detailed evidence in History. If the arguments are rejected, rewrite and retry. You have at most three model responses (the initial response and two corrections). Request only one cut per response, and do not repeat an accepted request. Ready alone does not complete this phase. Do not access history or other tools.`;

export interface MaintenanceResult {
	completed: boolean;
	requests: number;
	corrections: number;
	toolCalls: number;
	toolErrors: number;
	noCutReplies: number;
	cuts: number;
	archiveFallbacks: number;
	elapsedMs: number;
	error?: string;
}

/** Evaluation-only recovery policy. Production tools remain usable without this request cap. */
export async function runHandoffMaintenance(
	session: AgentSession,
	options: { dispatch?: StreamFn; timeoutMs?: number } = {},
): Promise<MaintenanceResult> {
	const previousStream = session.agent.streamFunction;
	const previousTools = session.getActiveToolNames();
	const dispatch = options.dispatch ?? previousStream;
	const initialCuts = session.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length;
	const startedAt = Date.now();
	let requests = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let archiveFallbacks = 0;
	let noCutReplies = 0;
	let timedOut = false;
	let terminalError: string | undefined;
	const countCuts = () =>
		session.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length - initialCuts;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "new_context") toolCalls++;
		if (event.type === "tool_execution_end" && event.toolName === "new_context" && !event.isError) {
			const details = (event.result as AgentToolResult<unknown>).details;
			if (details && typeof details === "object" && "archivedHandoffs" in details) archiveFallbacks++;
		}
		if (event.type === "tool_execution_end" && event.toolName === "new_context" && event.isError) {
			toolErrors++;
			const result = event.result as AgentToolResult<unknown>;
			const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			try {
				const error: unknown = JSON.parse(text);
				if (
					!error || typeof error !== "object" || !("code" in error) ||
					(error.code !== "handoff_too_large" && error.code !== "handoff_empty")
				) terminalError = `Non-correctable tool failure: ${text}`;
			} catch {
				terminalError = `Non-correctable tool failure: ${text}`;
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "stop" && event.message.content.length > 0 && countCuts() === 0) noCutReplies++;
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				terminalError = event.message.errorMessage ?? event.message.stopReason;
			}
		}
	});
	// Gate every provider continuation, including automatic continuations after tool errors.
	session.agent.streamFunction = (model, context, streamOptions) => {
		if (countCuts() === 0 && requests < MAX_MAINTENANCE_REQUESTS && !terminalError && !timedOut) {
			requests++;
			return dispatch(model, context, streamOptions);
		}
		const message: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	const timer = setTimeout(() => { timedOut = true; void session.abort(); }, options.timeoutMs ?? 1_200_000);
	try {
		session.setActiveToolsByName(["new_context"]);
		let prompt = MAINTENANCE_PROMPT;
		while (requests < MAX_MAINTENANCE_REQUESTS && countCuts() === 0 && !terminalError && !timedOut) {
			await session.prompt(prompt, {
				expandPromptTemplates: false,
				isolatedDirectExecution: { reason: "Host-authorized memory-only controlled experiment" },
			});
			if (countCuts() > 0 || terminalError || timedOut) break;
			if (requests < MAX_MAINTENANCE_REQUESTS) {
				prompt = `No context-window cut was persisted. This phase is incomplete; Ready is not sufficient. ${MAX_MAINTENANCE_REQUESTS - requests} model responses remain. ${MAINTENANCE_PROMPT}`;
			}
		}
	} catch (error) {
		terminalError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		unsubscribe();
		session.agent.streamFunction = previousStream;
		session.setActiveToolsByName(previousTools);
	}
	const cuts = countCuts();
	const error = timedOut ? "Maintenance deadline exceeded" : terminalError ??
		(cuts === 1 ? undefined : cuts > 1 ? "Multiple context-window cuts persisted" : "Maintenance correction budget exhausted without a persisted cut");
	return {
		completed: error === undefined && cuts === 1, requests, corrections: Math.max(0, requests - 1),
		toolCalls, toolErrors, noCutReplies, cuts, archiveFallbacks, elapsedMs: Date.now() - startedAt, error,
	};
}
