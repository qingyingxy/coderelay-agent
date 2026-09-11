import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { RpcClient, type RpcClientOptions } from "../../modes/rpc/rpc-client.ts";
import { STRUCTURED_HANDOFF_INSTRUCTION } from "./handoff.ts";
import type { SubagentSession, SubagentSessionConfig, SubagentSessionFactory } from "./types.ts";
import { formatWorkerExecutionContext } from "./worker-context.ts";

const RPC_ABORT_GRACE_MS = 1_000;

export interface RpcSubagentSessionFactoryOptions {
	readonly command?: string;
	readonly commandArgs?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly thinkingLevel?: ThinkingLevel;
	/** Caller-owned absolute file, avoiding large prompts in process command lines. */
	readonly systemPromptFile?: string;
}

export interface DefaultRpcInvocationOptions {
	readonly currentScript?: string;
	readonly currentModule?: string;
	readonly execPath?: string;
	readonly execArgv?: readonly string[];
}

export function resolveDefaultRpcInvocation(options: DefaultRpcInvocationOptions = {}): {
	command: string;
	commandArgs: string[];
} {
	const currentScript = options.currentScript ?? process.argv[1];
	const execPath = options.execPath ?? process.execPath;
	const execArgv = options.execArgv ?? process.execArgv;
	if (
		currentScript &&
		/(?:^|[\\/])(?:src|dist)[\\/]cli\.(?:ts|js|mjs)$/.test(currentScript) &&
		!currentScript.startsWith("/$bunfs/root/") &&
		existsSync(currentScript)
	) {
		return { command: execPath, commandArgs: [currentScript] };
	}
	const executableName = basename(execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(executableName)) {
		const currentModule = options.currentModule ?? fileURLToPath(import.meta.url);
		const cliExtension = extname(currentModule).toLowerCase() === ".ts" ? ".ts" : ".js";
		const siblingCli = resolve(dirname(currentModule), `../../cli${cliExtension}`);
		if (existsSync(siblingCli)) {
			return { command: execPath, commandArgs: [...execArgv, siblingCli] };
		}
		return { command: "pi", commandArgs: [] };
	}
	return { command: execPath, commandArgs: [] };
}

class RpcSubagentSession implements SubagentSession {
	readonly #client: RpcClient;
	readonly #executionReason: string | undefined;
	readonly #expectedModel: string | undefined;
	readonly #persistentWindows: boolean;
	readonly #expectedThinking: ThinkingLevel | undefined;

	constructor(
		options: RpcClientOptions,
		executionReason?: string,
		expectedModel?: string,
		persistentWindows = false,
		expectedThinking?: ThinkingLevel,
	) {
		this.#client = new RpcClient(options);
		this.#executionReason = executionReason;
		this.#expectedModel = expectedModel;
		this.#persistentWindows = persistentWindows;
		this.#expectedThinking = expectedThinking;
	}

	async start(): Promise<void> {
		await this.#client.start();
		if (this.#expectedThinking) {
			const state = await this.#client.getState();
			if (state.thinkingLevel !== this.#expectedThinking) {
				throw new Error(
					`Subagent thinking level mismatch: requested ${this.#expectedThinking}, received ${state.thinkingLevel}`,
				);
			}
		}
		if (this.#executionReason) {
			await this.#client.setWorkflowAutomation(false);
			const state = await this.#client.getState();
			if (
				state.workflowMode !== "direct" ||
				state.workflowAutomationEnabled ||
				(this.#persistentWindows && (state.contextManagementMode !== "windowed" || !state.sessionFile)) ||
				(this.#expectedModel && `${state.model?.provider}/${state.model?.id}` !== this.#expectedModel)
			) {
				throw new Error(
					"Subagent startup did not preserve its model, requested context persistence, and isolated Direct configuration",
				);
			}
		}
	}

	async stop(): Promise<void> {
		// Let the child settle its workflow and release leases before terminating it.
		await this.abort();
	}

	async prompt(message: string): Promise<void> {
		await this.#client.prompt(
			message,
			undefined,
			this.#executionReason ? { reason: this.#executionReason } : undefined,
		);
	}

	async steer(message: string): Promise<void> {
		await this.#client.steer(message);
	}

	async abort(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.#client.abort().catch(() => undefined),
				new Promise<void>((resolveAbort) => {
					timer = setTimeout(resolveAbort, RPC_ABORT_GRACE_MS);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			await this.#client.stop();
		}
	}

	async waitForIdle(timeoutMs: number): Promise<void> {
		await this.#client.waitForIdle(timeoutMs);
	}

	async getSessionId(): Promise<string> {
		return (await this.#client.getState()).sessionId;
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#client.getLastAssistantText();
	}

	async getUsage() {
		const stats = await this.#client.getSessionStats();
		return {
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cacheReadTokens: stats.tokens.cacheRead,
			cacheWriteTokens: stats.tokens.cacheWrite,
			cost: stats.cost,
			turns: stats.assistantMessages,
			durationMs: 0,
		};
	}

	onEvent(listener: (event: unknown) => void): () => void {
		return this.#client.onEvent(listener);
	}
}

export class RpcSubagentSessionFactory implements SubagentSessionFactory {
	readonly #options: RpcSubagentSessionFactoryOptions;

	constructor(options: RpcSubagentSessionFactoryOptions = {}) {
		this.#options = options;
	}

	create(config: SubagentSessionConfig): SubagentSession {
		const invocation = resolveDefaultRpcInvocation();
		const modelName = config.modelName ?? config.profile.model;
		const isolatedReviewer =
			config.profile.role === "reviewer" &&
			!config.effectivePermissions.write &&
			!config.effectivePermissions.executeCommands &&
			!config.effectivePermissions.network;
		const args = ["--no-session", "--workflow-mode", "direct"];
		if (config.contextWindow) {
			if (config.profile.role !== "worker" || !config.effectivePermissions.read) {
				throw new Error("Persistent context windows require a Worker with read permission");
			}
			if (!isAbsolute(config.contextWindow.sessionDir)) {
				throw new Error("Worker context window sessionDir must be absolute");
			}
			for (const name of ["new_context", "history", "notes"]) {
				if (!config.toolNames.includes(name)) {
					throw new Error(`Worker context windows require the explicitly allowed ${name} tool`);
				}
			}
			args.splice(0, 1);
			args.push("--context-mode", "windowed", "--session-dir", config.contextWindow.sessionDir);
		}
		if (config.toolNames.length > 0) {
			args.push("--tools", config.toolNames.join(","));
		} else {
			args.push("--no-tools");
		}
		const systemPrompt = [
			config.profile.systemPrompt.trim(),
			...(config.contextWindow?.executionContract
				? [formatWorkerExecutionContext(config.contextWindow.executionContract)]
				: []),
			`Effective permissions: ${JSON.stringify(config.effectivePermissions)}`,
			`Hard budget: ${JSON.stringify(config.budget)}`,
			STRUCTURED_HANDOFF_INSTRUCTION,
		].join("\n\n");
		const systemPromptFile = this.#options.systemPromptFile;
		if (systemPromptFile) {
			if (!isAbsolute(systemPromptFile)) throw new Error("System prompt file must be absolute");
			writeFileSync(systemPromptFile, systemPrompt, { encoding: "utf8", mode: 0o600 });
		}
		args.push("--append-system-prompt", systemPromptFile ?? systemPrompt);
		if (modelName) {
			args.push("--model", modelName);
		}
		const thinkingLevel = config.profile.thinkingLevel ?? this.#options.thinkingLevel;
		if (thinkingLevel) {
			args.push("--thinking", thinkingLevel);
		}
		return new RpcSubagentSession(
			{
				command: this.#options.command ?? invocation.command,
				commandArgs: this.#options.commandArgs ? [...this.#options.commandArgs] : invocation.commandArgs,
				cwd: config.cwd,
				env: { ...config.environment, ...this.#options.env, PI_WORKFLOW_NETWORK_RETRY: "1" },
				inheritParentEnv: config.environment === undefined,
				requestTimeoutMs: config.responseTimeoutMs ?? config.budget.maxDurationMs,
				args,
			},
			config.contextWindow?.executionContract
				? `Parent-approved Worker Attempt ${config.contextWindow.executionContract.attemptId}; parent owns permissions, budget, and external verification`
				: isolatedReviewer
					? "Parent-requested read-only review; parent owns planning, approval, and delivery decisions"
					: undefined,
			config.contextWindow?.executionContract || isolatedReviewer ? modelName : undefined,
			Boolean(config.contextWindow?.executionContract),
			thinkingLevel,
		);
	}
}
