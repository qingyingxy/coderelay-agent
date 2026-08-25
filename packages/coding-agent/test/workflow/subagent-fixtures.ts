import type { ResourceUsage, SubagentSession, SubagentSessionConfig, SubagentSessionFactory } from "../../src/index.ts";

export const SUBAGENT_HANDOFF = JSON.stringify({
	conclusion: "Inspection completed",
	evidence: [{ path: "src/index.ts", line: 12, note: "Entry point" }],
	architectureFindings: ["Workflow owns authoritative state"],
	changedFiles: [],
	verificationSummary: ["Reviewed result"],
	risks: [],
	unfinishedItems: [],
});

export function subagentHandoff(
	overrides: Partial<{
		conclusion: string;
		evidence: readonly { path: string; line?: number; note: string }[];
		architectureFindings: readonly string[];
		changedFiles: readonly string[];
		verificationSummary: readonly string[];
		risks: readonly string[];
		unfinishedItems: readonly string[];
	}> = {},
): string {
	return JSON.stringify({
		conclusion: "Inspection completed",
		evidence: [{ path: "src/index.ts", line: 12, note: "Entry point" }],
		architectureFindings: ["Workflow owns authoritative state"],
		changedFiles: [],
		verificationSummary: ["Reviewed result"],
		risks: [],
		unfinishedItems: [],
		...overrides,
	});
}

const ZERO_USAGE: ResourceUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	durationMs: 0,
};

export class FakeSubagentSession implements SubagentSession {
	readonly config: SubagentSessionConfig;
	readonly sessionId: string;
	readonly promptCalls: string[] = [];
	readonly steerCalls: string[] = [];
	readonly listeners = new Set<(event: unknown) => void>();
	startCalls = 0;
	stopCalls = 0;
	abortCalls = 0;
	output: string | null = null;
	repairOutput: string | null = null;
	repairUsage: ResourceUsage | undefined;
	repairCompletesSynchronously = false;
	usage: ResourceUsage = ZERO_USAGE;
	#resolveIdle?: () => void;
	#rejectIdle?: (error: Error) => void;

	constructor(config: SubagentSessionConfig, sessionId: string) {
		this.config = config;
		this.sessionId = sessionId;
	}

	async start(): Promise<void> {
		this.startCalls++;
	}

	async stop(): Promise<void> {
		this.stopCalls++;
	}

	async prompt(message: string): Promise<void> {
		this.promptCalls.push(message);
		if (this.repairOutput && message.includes("Format validation failed")) {
			this.output = this.repairOutput;
			this.usage = this.repairUsage ?? this.usage;
			if (this.repairCompletesSynchronously) {
				this.#resolveIdle?.();
			} else {
				setTimeout(() => this.#resolveIdle?.(), 0);
			}
		}
	}

	async steer(message: string): Promise<void> {
		this.steerCalls.push(message);
	}

	async abort(): Promise<void> {
		this.abortCalls++;
		this.#resolveIdle?.();
	}

	waitForIdle(_timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#resolveIdle = resolve;
			this.#rejectIdle = reject;
		});
	}

	async getSessionId(): Promise<string> {
		return this.sessionId;
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.output;
	}

	async getUsage(): Promise<ResourceUsage> {
		return this.usage;
	}

	onEvent(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: unknown): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	complete(output = SUBAGENT_HANDOFF, usage: ResourceUsage = ZERO_USAGE): void {
		this.output = output;
		this.usage = usage;
		this.#resolveIdle?.();
	}

	fail(error: Error): void {
		this.#rejectIdle?.(error);
	}
}

export class FakeSubagentSessionFactory implements SubagentSessionFactory {
	readonly sessions: FakeSubagentSession[] = [];

	create(config: SubagentSessionConfig): FakeSubagentSession {
		const session = new FakeSubagentSession(config, `session-${this.sessions.length + 1}`);
		this.sessions.push(session);
		return session;
	}
}
