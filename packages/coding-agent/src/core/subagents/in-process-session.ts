import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ResourceUsage } from "../workflow/types.ts";
import { STRUCTURED_HANDOFF_INSTRUCTION } from "./handoff.ts";
import type { SubagentSession, SubagentSessionConfig, SubagentSessionFactory } from "./types.ts";

export interface InProcessAgentSession {
	readonly sessionId: string;
	readonly messages: readonly AgentMessage[];
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	getSessionStats(): {
		readonly assistantMessages: number;
		readonly tokens: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
		};
		readonly cost: number;
	};
	subscribe(listener: (event: unknown) => void): () => void;
	dispose(): void;
}

export type InProcessAgentSessionCreator = (config: SubagentSessionConfig) => Promise<InProcessAgentSession>;

function assistantText(messages: readonly AgentMessage[]): string | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(({ text }) => text)
			.join("\n")
			.trim();
		if (text) {
			return text;
		}
	}
	return null;
}

class InProcessSubagentSession implements SubagentSession {
	readonly #config: SubagentSessionConfig;
	readonly #createSession: InProcessAgentSessionCreator;
	readonly #listeners = new Set<(event: unknown) => void>();
	#session?: InProcessAgentSession;
	#unsubscribe?: () => void;
	#runPromise?: Promise<void>;
	readonly #runStartWaiters = new Set<() => void>();
	#stopped = false;

	constructor(config: SubagentSessionConfig, createSession: InProcessAgentSessionCreator) {
		this.#config = config;
		this.#createSession = createSession;
	}

	async start(): Promise<void> {
		if (this.#session) {
			return;
		}
		this.#session = await this.#createSession(this.#config);
		this.#unsubscribe = this.#session.subscribe((event) => {
			for (const listener of this.#listeners) {
				listener(event);
			}
		});
	}

	async stop(): Promise<void> {
		if (this.#stopped) {
			return;
		}
		this.#stopped = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#session?.dispose();
	}

	async prompt(message: string): Promise<void> {
		const session = this.#requireSession();
		const prompt = [
			this.#config.profile.systemPrompt.trim(),
			`Effective permissions: ${JSON.stringify(this.#config.effectivePermissions)}`,
			`Hard budget: ${JSON.stringify(this.#config.budget)}`,
			STRUCTURED_HANDOFF_INSTRUCTION,
			message,
		].join("\n\n");
		this.#runPromise = session.prompt(prompt);
		void this.#runPromise.catch(() => undefined);
		for (const resolve of this.#runStartWaiters) {
			resolve();
		}
		this.#runStartWaiters.clear();
	}

	async steer(message: string): Promise<void> {
		await this.#requireSession().steer(message);
	}

	async abort(): Promise<void> {
		await this.#requireSession().abort();
	}

	async waitForIdle(timeoutMs: number): Promise<void> {
		const session = this.#requireSession();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			if (!this.#runPromise) {
				await new Promise<void>((resolve) => this.#runStartWaiters.add(resolve));
			}
			const runPromise = this.#runPromise;
			if (!runPromise) {
				throw new Error("In-process Subagent run did not start");
			}
			await Promise.race([
				Promise.all([session.waitForIdle(), runPromise]).then(() => undefined),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error(`In-process Subagent timed out after ${timeoutMs}ms`)),
						timeoutMs,
					);
				}),
			]);
			if (this.#runPromise === runPromise) {
				this.#runPromise = undefined;
			}
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
		}
	}

	async getSessionId(): Promise<string> {
		return this.#requireSession().sessionId;
	}

	async getLastAssistantText(): Promise<string | null> {
		return assistantText(this.#requireSession().messages);
	}

	async getUsage(): Promise<ResourceUsage> {
		const stats = this.#requireSession().getSessionStats();
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
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#requireSession(): InProcessAgentSession {
		if (!this.#session) {
			throw new Error("In-process Subagent Session has not started");
		}
		return this.#session;
	}
}

export class InProcessSubagentSessionFactory implements SubagentSessionFactory {
	readonly #createSession: InProcessAgentSessionCreator;

	constructor(createSession: InProcessAgentSessionCreator) {
		this.#createSession = createSession;
	}

	create(config: SubagentSessionConfig): SubagentSession {
		return new InProcessSubagentSession(config, this.#createSession);
	}
}
