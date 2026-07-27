/**
 * Subagent Runtime Demo
 *
 * Demonstrates isolated Sessions, parallel read-only Agents, structured
 * Handoff validation, aggregation, and parent-visible Agent state.
 *
 * Run from the repository root:
 *   npm run demo:subagent-runtime
 */

import {
	aggregateHandoffs,
	BUILTIN_AGENT_PROFILES,
	FULL_PERMISSION_SET,
	type ResourceUsage,
	SubagentRuntime,
	type SubagentSession,
	type SubagentSessionConfig,
	type SubagentSessionFactory,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "@earendil-works/pi-coding-agent";

const ZERO_USAGE: ResourceUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	durationMs: 0,
};

class DemoSession implements SubagentSession {
	readonly sessionId: string;
	readonly conclusion: string;
	#resolveIdle?: () => void;

	constructor(sessionId: string, conclusion: string) {
		this.sessionId = sessionId;
		this.conclusion = conclusion;
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async prompt(): Promise<void> {
		queueMicrotask(() => this.#resolveIdle?.());
	}

	async steer(): Promise<void> {}

	async abort(): Promise<void> {
		this.#resolveIdle?.();
	}

	waitForIdle(): Promise<void> {
		return new Promise((resolve) => {
			this.#resolveIdle = resolve;
		});
	}

	async getSessionId(): Promise<string> {
		return this.sessionId;
	}

	async getLastAssistantText(): Promise<string> {
		return JSON.stringify({
			conclusion: this.conclusion,
			evidence: [{ path: "packages/coding-agent/src/core/agent-session.ts", note: this.conclusion }],
			architectureFindings: ["WorkflowController owns Task state"],
			changedFiles: [],
			verificationSummary: ["Read-only inspection completed"],
			risks: [],
			unfinishedItems: [],
		});
	}

	async getUsage(): Promise<ResourceUsage> {
		return { ...ZERO_USAGE, inputTokens: 20, outputTokens: 10, turns: 1 };
	}

	onEvent(): () => void {
		return () => undefined;
	}
}

class DemoSessionFactory implements SubagentSessionFactory {
	#sequence = 0;

	create(_config: SubagentSessionConfig): SubagentSession {
		const sequence = ++this.#sequence;
		return new DemoSession(`demo-session-${sequence}`, `Inspection ${sequence} completed`);
	}
}

let idSequence = 0;
const runtime = new SubagentRuntime({
	sessionFactory: new DemoSessionFactory(),
	runtimeRegistry: new WorkflowRuntimeRegistry(),
	writerLeaseRegistry: new WriterLeaseRegistry(),
	createId: (kind) => `${kind}-${++idSequence}`,
});
const sharedInput = {
	workflowId: "workflow-subagent-demo",
	cwd: process.cwd(),
	profile: BUILTIN_AGENT_PROFILES.explorer,
	parentPermission: FULL_PERMISSION_SET,
	workflowPermission: FULL_PERMISSION_SET,
	taskPermission: FULL_PERMISSION_SET,
	parentBudget: { maxConcurrentAgents: 2, maxAgentDepth: 2 },
	workflowBudget: { maxConcurrentAgents: 2, maxAgentDepth: 2 },
	taskBudget: { maxTurns: 4 },
};
const [first, second] = await Promise.all([
	runtime.spawn({ ...sharedInput, taskId: "inspect-cli", attemptId: "attempt-cli" }),
	runtime.spawn({ ...sharedInput, taskId: "inspect-runtime", attemptId: "attempt-runtime" }),
]);
await Promise.all([
	runtime.send(first.id, "Inspect CLI integration"),
	runtime.send(second.id, "Inspect Runtime integration"),
]);
const results = await Promise.all([runtime.wait(first.id), runtime.wait(second.id)]);
const handoffs = results.flatMap(({ handoff }) => (handoff ? [handoff] : []));
if (handoffs.length !== 2 || results.some(({ status }) => status !== "completed")) {
	throw new Error("Subagent execution did not complete");
}
const aggregate = aggregateHandoffs(handoffs);
if (aggregate.conclusions.length !== 2 || aggregate.architectureFindings.length !== 1) {
	throw new Error("Handoff aggregation failed");
}

console.log(
	`[agents] ${runtime
		.list("workflow-subagent-demo")
		.map(({ id, status }) => `${id}:${status}`)
		.join(", ")}`,
);
console.log(
	`[sessions] ${runtime
		.list()
		.map(({ sessionId }) => sessionId)
		.join(", ")}`,
);
console.log(`[handoffs] ${aggregate.conclusions.join("; ")}`);
console.log(`[findings] ${aggregate.architectureFindings.join("; ")}`);
await runtime.dispose();
console.log("[demo] PASS");
