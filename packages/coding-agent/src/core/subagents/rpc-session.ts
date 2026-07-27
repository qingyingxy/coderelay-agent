import { existsSync } from "node:fs";
import { basename } from "node:path";
import { RpcClient, type RpcClientOptions } from "../../modes/rpc/rpc-client.ts";
import { STRUCTURED_HANDOFF_INSTRUCTION } from "./handoff.ts";
import type { SubagentSession, SubagentSessionConfig, SubagentSessionFactory } from "./types.ts";

export interface RpcSubagentSessionFactoryOptions {
	readonly command?: string;
	readonly commandArgs?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

function defaultInvocation(): { command: string; commandArgs: string[] } {
	const currentScript = process.argv[1];
	if (
		currentScript &&
		/(?:^|[\\/])(?:src|dist)[\\/]cli\.(?:ts|js|mjs)$/.test(currentScript) &&
		!currentScript.startsWith("/$bunfs/root/") &&
		existsSync(currentScript)
	) {
		return { command: process.execPath, commandArgs: [currentScript] };
	}
	const executableName = basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(executableName)) {
		return { command: "pi", commandArgs: [] };
	}
	return { command: process.execPath, commandArgs: [] };
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
		await this.#client.abort();
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
		const invocation = defaultInvocation();
		const args = ["--no-session"];
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
		if (config.profile.model) {
			args.push("--model", config.profile.model);
		}
		return new RpcSubagentSession({
			command: this.#options.command ?? invocation.command,
			commandArgs: this.#options.commandArgs ? [...this.#options.commandArgs] : invocation.commandArgs,
			cwd: config.cwd,
			env: this.#options.env ? { ...this.#options.env } : undefined,
			args,
		});
	}
}
