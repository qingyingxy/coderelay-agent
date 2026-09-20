import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSession, createExtensionRuntime, defineTool, type ModelRuntime, type ResourceLoader, SessionManager, SettingsManager } from "../../src/index.ts";
import { PierBudget, type PierRunConfig } from "./pier-budget.ts";
import { PierControlledReplay } from "./pier-controlled-replay.ts";

export interface ContainerReply { stdout: string; stderr: string; return_code: number }

export const PIER_CAPABILITY_PROBE = 'for tool in git python python3 perl patch apply_patch rg; do if command -v "$tool" >/dev/null 2>&1; then printf "%s=available\\n" "$tool"; else printf "%s=missing\\n" "$tool"; fi; done';


export function classifyPierRuntime(state: {
	timedOut: boolean; budgetStopped: boolean; failed: boolean; normalFinal: boolean;
	workflowStatus?: string; clarificationPending: boolean; containerCalls: number; containerReplies: number;
}) {
	if (state.timedOut) return "timeout";
	if (state.workflowStatus === "awaiting_approval") return "waiting_for_approval";
	if (state.clarificationPending) return "waiting_for_clarification";
	if (state.budgetStopped) return "budget_or_provider_stop";
	if (state.failed || !state.normalFinal) return "incomplete";
	if (state.workflowStatus === "planning") return "planning";
	if (state.workflowStatus && state.workflowStatus !== "completed") return "incomplete";
	if (state.containerCalls === 0) return "no_execution";
	if (state.containerReplies !== state.containerCalls) return "incomplete";
	return "runtime_completed";
}

export async function runPierSession(config: PierRunConfig, instruction: string, output: string,
	runtime: ModelRuntime, model: Model<Api>, execute: (command: string) => Promise<ContainerReply>, checkpoint?: string) {
	mkdirSync(output, { recursive: true });
	const controlled = checkpoint ? new PierControlledReplay(checkpoint, config.group, output, instruction) : undefined;
	let containerCalls = 0;
	let containerReplies = 0;
	const started = Date.now();
	const budget = new PierBudget(config, (receipt) => appendFileSync(join(output, "budget.jsonl"), `${JSON.stringify(receipt)}\n`));
	if (controlled) {
		const restored = await execute(controlled.restoreCommand);
		writeFileSync(join(output, "controlled-repository.json"), JSON.stringify(restored, null, 2));
		if (restored.return_code !== 0) throw new Error("Controlled repository checkpoint mismatch");
	}
	const capabilities = await execute(PIER_CAPABILITY_PROBE);
	writeFileSync(join(output, "capabilities.json"), JSON.stringify({ command: PIER_CAPABILITY_PROBE, ...capabilities }, null, 2));
	if (capabilities.return_code !== 0 || !capabilities.stdout.split(/\r?\n/).includes("git=available")) {
		throw new Error("Container capability probe requires git before model dispatch");
	}
	let submission: { verification: ContainerReply; commit?: ContainerReply; submitted: boolean } | undefined;
	let verificationCommand: string | undefined;
	let submissionAttempts = 0;
	const systemPrompt = [
		"Implement the supplied task in /app. Use container_exec for repository operations and container_submit to verify and commit before finishing.",
		"All tools execute inside the disposable target container. Host commands and editors are not available there unless the capability probe lists them.",
		`Observed container capabilities:\n${capabilities.stdout}`,
		"Use available Python with pathlib for file edits if no patch helper is available. apply_patch format is not a git apply or patch unified diff. Do not retry incompatible patch formats.",
		"Tests in the separate official verifier are unavailable. Record failed attempts and unresolved work honestly. Do not claim official verification from local tests.",
		"Before final submission, compare the original requirements with available verification evidence and resolve unverified or unchecked work shown in the continuity seed. Changed code is not verified behavior. Include affected public interfaces and shared-code regressions in local checks; report checks you cannot run. Keep ordinary progress out of Notes; use Notes for durable constraints, decisions and discoveries.",
		"If verification fails, use container_exec to repair, then retry container_submit with the identical verification_command. Execution and memory tools remain available after failed checks. Resolve known failed checks before submitting; a narrower passing check does not resolve an earlier failure. Do not weaken tests or embed edits in verification commands. Failed verification does not commit. Any container_exec after submission requires fresh verification and submission. A commit alone is not official success.",
	].join("\n\n");
	const resources: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt, getAppendSystemPrompt: () => [], extendResources: () => {}, reload: async () => {},
	};
	const tool = defineTool({
		name: "container_exec", label: "Container", description: "Run a shell command in isolated /app; returns stdout, stderr and exit code. Timeout 60 seconds; output is bounded.",
		executionMode: "sequential", parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16384 }) }),
		execute: async (_id, params, signal) => {
			signal?.throwIfAborted();
			const cached = controlled?.toolResult(_id, params.command);
			if (cached) return cached;
			// Arbitrary shell commands may modify the repository, even if they fail.
			if (submission?.submitted) {
				submission = undefined;
				writeFileSync(join(output, "submission.json"), "null\n");
			}
			containerCalls++;
			const result = await execute(params.command);
			containerReplies++;
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	const submitTool = defineTool({
		name: "container_submit", label: "Submit", description: "Run git diff --check and a bounded local verification command, then commit all task changes only if both pass. Returns verification and commit evidence. Does not run official tests.",
		executionMode: "sequential", parameters: Type.Object({
			verification_command: Type.String({ minLength: 1, maxLength: 4096 }),
			message: Type.String({ minLength: 1, maxLength: 200 }),
		}),
		execute: async (_id, params, signal) => {
			signal?.throwIfAborted();
			if (verificationCommand !== undefined && params.verification_command !== verificationCommand) {
				throw new Error("Reverification must use the original verification_command");
			}
			if (controlled && !controlled.continued) throw new Error("Submission before controlled maintenance");
			verificationCommand = params.verification_command;
			submissionAttempts++;
			submission = undefined;
			writeFileSync(join(output, "submission.json"), "null\n");
			containerCalls++;
			const verification = await execute(`git diff --check && (\n${params.verification_command}\n)`);
			containerReplies++;
			submission = { verification, submitted: false };
			if (verification.return_code === 0 && !signal?.aborted) {
				const message = `'${params.message.replace(/'/g, "'\\''")}'`;
				containerCalls++;
				submission.commit = await execute(`git add -A && (git diff --cached --quiet || git -c user.name='Pi Evaluation' -c user.email='pi-eval@example.invalid' commit -m ${message}) && git rev-parse HEAD && git status --porcelain`);
				containerReplies++;
				submission.submitted = submission.commit.return_code === 0;
			}
			appendFileSync(join(output, "submission-attempts.jsonl"), `${JSON.stringify({ attempt: submissionAttempts, verificationCommand, ...submission })}\n`);
			writeFileSync(join(output, "submission.json"), JSON.stringify(submission, null, 2));
			if (!submission.submitted) throw new Error(`Submission failed: ${JSON.stringify(submission)}`);
			return { content: [{ type: "text", text: JSON.stringify(submission) }], details: submission };
		},
	});
	const manager = SessionManager.create(output, join(output, "sessions"));
	const { session } = await createAgentSession({
		cwd: output, agentDir: output, modelRuntime: runtime,
		model: { ...model, contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens, cost: config.pricing },
		thinkingLevel: "medium", resourceLoader: resources, sessionManager: manager,
		tools: ["container_exec", "container_submit", "history", "notes", ...(config.group === "C" ? ["new_context"] : [])], customTools: [tool, submitTool],
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16000 },
			contextManagement: { mode: config.group === "C" ? "windowed" : "summary", reserveTokens: 16000, notesHintMaxBytes: 4000, historyResultMaxBytes: 16000 },
			retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120000 } },
		}),
	});
	if (config.group === "C") session.enableWorkflowTracking("direct");
	session.agent.streamFunction = budget.wrap(session.agent.streamFunction);
	controlled?.install(session, manager, runtime);
	const tools = session.getActiveToolNames();
	if (tools.some((name) => ["bash", "read", "write", "edit", "grep", "find", "ls"].includes(name))) {
		session.dispose(); throw new Error("Host repository tool exposed");
	}
	writeFileSync(join(output, "run-config.json"), JSON.stringify({ ...config, thinking: "medium", tools,
		...(controlled ? { controlledProtocol: "single-boundary-v1" } : {}),
		executionPolicy: "isolated-fixed-direct-v4", workflowTracking: config.group === "C",
		isolation: "Host-owned disposable Pier /app container; no host repository tools, extensions, or subagents",
		instructionSha256: createHash("sha256").update(instruction).digest("hex"),
		systemPromptSha256: createHash("sha256").update(systemPrompt).digest("hex"), pricingIsEstimate: true }, null, 2));
	session.subscribe((event) => {
		appendFileSync(join(output, "events.jsonl"), `${JSON.stringify(event)}\n`);
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		budget.stopped = "Evaluation timeout";
		void session.abort();
	}, config.timeoutSeconds * 1000);
	let failed = false;
	try { await session.prompt(instruction, {
		expandPromptTemplates: false,
		...(config.group === "C" ? { isolatedDirectExecution: {
			reason: "Preauthorized benchmark in disposable Pier container; fixed A/C execution; host owns tool isolation",
		} } : {}),
	}); } catch { failed = true; }
	finally { clearTimeout(timer); }
	const branch = manager.getBranch();
	const replies = branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
	const last = replies.at(-1);
	const normalFinal = Boolean(last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "stop");
	const providerFailure = replies.some((entry) => entry.type === "message" && entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason));
	const workflow = session.getWorkflowView()?.workflow;
	const windows = branch.filter((entry) => entry.type === "context_window");
	const controlledBoundaryCount = config.group === "C" ? windows.length : branch.filter((entry) => entry.type === "compaction").length;
	const runtimeStatus = classifyPierRuntime({ timedOut, budgetStopped: Boolean(budget.stopped), failed: failed || providerFailure,
		normalFinal, workflowStatus: workflow?.status, clarificationPending: session.workflowClarificationPending, containerCalls, containerReplies });
	const result = {
		controlledReplay: controlled?.report(),
		status: controlled && (!controlled.continued || controlledBoundaryCount !== 1) ? "controlled_boundary_incomplete" : runtimeStatus === "runtime_completed" && !submission?.submitted ? "submission_incomplete" : runtimeStatus,
		submission: submission ?? null, submissionAttempts,
		containerCalls, containerReplies, workflowStatus: workflow?.status ?? null,
		workflowModeDecision: workflow?.modeDecision ?? null,
		snapshotWindows: windows.filter((entry) => entry.snapshotEntryId && entry.workflowId && entry.contextSeed.workflowSnapshotSequence !== undefined).length,
		group: config.group, requests: budget.requests, accountedUsd: budget.accountedUsd,
		usageUncertain: budget.receipts.some((receipt) => receipt.status === "unknown"), stopReason: budget.stopped,
		elapsedMs: Date.now() - started, windows: windows.length,
		compactions: branch.filter((entry) => entry.type === "compaction").length,
		inputTokens: budget.receipts.reduce((sum, receipt) => sum + (receipt.inputTokens ?? 0), 0),
		outputTokens: budget.receipts.reduce((sum, receipt) => sum + (receipt.outputTokens ?? 0), 0),
		officialTaskSuccess: null,
	};
	writeFileSync(join(output, "sdk-result.json"), JSON.stringify(result, null, 2));
	session.dispose();
	return result;
}
