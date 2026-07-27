/**
 * CLI Agent Showcase
 *
 * Demonstrates Plan approval, Task scheduling, background Job execution,
 * failed delivery verification, Repair Subagent, terminal report, recovery,
 * and cancellation without provider calls.
 *
 * Run from the repository root:
 *   npm run demo:cli-agent-showcase
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DeliveryRuntime,
	type JobProcess,
	type JobProcessExit,
	type JobProcessFactory,
	JobRuntime,
	type PlanContent,
	PlanWorkflowRuntime,
	type ResourceUsage,
	SessionManager,
	type StartJobProcessInput,
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

class ShowcaseProcess implements JobProcess {
	readonly pid: number;
	readonly #input: StartJobProcessInput;
	readonly #exitCode: number;

	constructor(pid: number, input: StartJobProcessInput, exitCode: number) {
		this.pid = pid;
		this.#input = input;
		this.#exitCode = exitCode;
	}

	async wait(): Promise<JobProcessExit> {
		this.#input.onStdout(`${this.#input.command}: exit ${this.#exitCode}\n`);
		return { exitCode: this.#exitCode };
	}

	async terminate(): Promise<void> {}
}

class ShowcaseProcessFactory implements JobProcessFactory {
	readonly #exitCodes: number[];
	#sequence = 0;

	constructor(exitCodes: readonly number[]) {
		this.#exitCodes = [...exitCodes];
	}

	start(input: StartJobProcessInput): JobProcess {
		const index = this.#sequence++;
		return new ShowcaseProcess(20_000 + index, input, this.#exitCodes[index] ?? 0);
	}
}

class ShowcaseSubagentSession implements SubagentSession {
	readonly sessionId = "showcase-subagent-session";
	#resolveIdle?: () => void;

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(_message: string): Promise<void> {}
	async steer(_message: string): Promise<void> {}

	async abort(): Promise<void> {
		this.#resolveIdle?.();
	}

	waitForIdle(_timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			this.#resolveIdle = resolve;
			queueMicrotask(resolve);
		});
	}

	async getSessionId(): Promise<string> {
		return this.sessionId;
	}

	async getLastAssistantText(): Promise<string> {
		return JSON.stringify({
			conclusion: "Repair completed",
			evidence: [{ path: "src/cli-command.ts", line: 1, note: "Failure corrected" }],
			architectureFindings: ["Workflow remains the authoritative state owner"],
			changedFiles: ["src/cli-command.ts"],
			verificationSummary: ["Repair applied"],
			risks: [],
			unfinishedItems: [],
		});
	}

	async getUsage(): Promise<ResourceUsage> {
		return { ...ZERO_USAGE, turns: 1 };
	}

	onEvent(_listener: (event: unknown) => void): () => void {
		return () => undefined;
	}
}

class ShowcaseSubagentFactory implements SubagentSessionFactory {
	create(_config: SubagentSessionConfig): SubagentSession {
		return new ShowcaseSubagentSession();
	}
}

const CONTENT: PlanContent = {
	goal: "Implement and verify a CLI command",
	assumptions: [],
	steps: [
		{
			id: "implement",
			kind: "command",
			command: "showcase-implement",
			title: "Implement command",
			description: "Apply a deterministic CLI change",
			dependsOn: [],
			fileIntents: [{ path: "src/cli-command.ts", action: "modify", reason: "Add command" }],
			verificationRequirementIds: ["implementation"],
		},
	],
	risks: [],
	verificationRequirements: [
		{
			id: "implementation",
			kind: "manual",
			description: "Implementation command succeeds",
			required: true,
		},
		{
			id: "tests",
			kind: "test",
			description: "Focused CLI tests pass",
			command: "showcase-test",
			required: true,
		},
	],
};

const workspace = mkdtempSync(join(tmpdir(), "pi-cli-agent-showcase-"));
const sessions = SessionManager.inMemory(workspace);

try {
	const workflow = PlanWorkflowRuntime.start(sessions, {
		workflowId: "workflow-showcase",
		rootTaskId: "task-root",
		planId: "plan-showcase",
		budget: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentJobs: 1 },
		request: {
			text: "Implement and verify a CLI command",
			cwd: workspace,
			attachments: [],
		},
	});
	workflow.submit(CONTENT);
	console.log(`[plan] ${workflow.workflow.status}; actions: ${workflow.view().availableActions.join(", ")}`);
	workflow.approve("Showcase approval");

	const jobs = new JobRuntime({
		processFactory: new ShowcaseProcessFactory([0, 1, 0]),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
	});
	const [implementation] = await workflow.startReadyJobs(jobs, 1);
	await implementation?.completion;
	console.log(
		`[job] implementation ${implementation?.job.id}: ${jobs.registry.get(implementation?.job.id ?? "")?.status}`,
	);

	const delivery = new DeliveryRuntime({
		jobRuntime: jobs,
		writerLeaseRegistry: new WriterLeaseRegistry(),
	});
	const failed = await delivery.run(workflow);
	if (failed.status !== "repair_created") {
		throw new Error("Expected the first delivery verification to create a Repair Task");
	}
	console.log(`[verify] failed; Repair Task: ${failed.repairTask?.id}`);

	const subagents = new SubagentRuntime({
		sessionFactory: new ShowcaseSubagentFactory(),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
		writerLeaseRegistry: new WriterLeaseRegistry(),
	});
	const [repair] = await workflow.startReadySubagents(subagents, 1);
	await repair?.completion;
	console.log(`[subagent] ${repair?.agent.id}: Repair completed`);

	const completed = await delivery.run(workflow);
	if (completed.status !== "completed") {
		throw new Error("Expected repaired Workflow to pass the Completion Gate");
	}
	for (const line of workflow.finalReport?.lines ?? []) {
		console.log(line);
	}

	const recovered = PlanWorkflowRuntime.recoverLatest(sessions, {}, workflow.workflow.id);
	if (recovered?.workflow.status !== "completed") {
		throw new Error("Expected terminal Workflow recovery to succeed");
	}
	console.log(`[recovery] ${recovered.workflow.id}: ${recovered.workflow.status}`);

	const cancelled = PlanWorkflowRuntime.start(sessions, {
		workflowId: "workflow-cancel-showcase",
		rootTaskId: "task-cancel-root",
		planId: "plan-cancel-showcase",
		request: {
			text: "Demonstrate cancellation",
			cwd: workspace,
			attachments: [],
		},
	});
	await cancelled.cancel("Showcase cancellation");
	console.log(`[cancel] ${cancelled.workflow.status}: ${cancelled.workflow.result?.reason}`);
	console.log("[showcase] PASS");
} finally {
	rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
