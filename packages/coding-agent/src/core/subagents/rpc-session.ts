import { existsSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { RpcClient, type RpcClientOptions } from "../../modes/rpc/rpc-client.ts";
import { STRUCTURED_HANDOFF_INSTRUCTION } from "./handoff.ts";
import type { SubagentSession, SubagentSessionConfig, SubagentSessionFactory } from "./types.ts";

const RPC_ABORT_GRACE_MS = 1_000;

export interface RpcSubagentSessionFactoryOptions {
	readonly command?: string;
	readonly commandArgs?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly thinkingLevel?: ThinkingLevel;
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

	constructor(options: RpcClientOptions) {
		this.#client = new RpcClient(options);
	}

	async start(): Promise<void> {
		await this.#client.start();
	}

	async stop(): Promise<void> {
		await this.#client.stop();
	}

	async prompt(message: string): Promise<void> {
		await this.#client.prompt(message);
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
		const args = ["--no-session", "--workflow-mode", "direct"];
		if (config.toolNames.length > 0) {
			args.push("--tools", config.toolNames.join(","));
		} else {
			args.push("--no-tools");
		}
		args.push(
			"--append-system-prompt",
			[
				config.profile.systemPrompt.trim(),
				`Effective permissions: ${JSON.stringify(config.effectivePermissions)}`,
				`Hard budget: ${JSON.stringify(config.budget)}`,
				STRUCTURED_HANDOFF_INSTRUCTION,
			].join("\n\n"),
		);
		if (modelName) {
			args.push("--model", modelName);
		}
		const thinkingLevel = config.profile.thinkingLevel ?? this.#options.thinkingLevel;
		if (thinkingLevel) {
			args.push("--thinking", thinkingLevel);
		}
		return new RpcSubagentSession({
			command: this.#options.command ?? invocation.command,
			commandArgs: this.#options.commandArgs ? [...this.#options.commandArgs] : invocation.commandArgs,
			cwd: config.cwd,
			env: config.environment
				? {
						...config.environment,
						...this.#options.env,
					}
				: this.#options.env
					? { ...this.#options.env }
					: undefined,
			inheritParentEnv: config.environment === undefined,
			requestTimeoutMs: config.budget.maxDurationMs,
			args,
		});
	}
}
