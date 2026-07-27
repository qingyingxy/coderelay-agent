/**
 * Autonomous Workflow Showcase
 *
 * Demonstrates approval followed by automatic scheduling, delivery verification,
 * bounded Repair, re-verification, terminal reporting, and recovery. There are
 * no manual dispatch, wait, or verify calls.
 *
 * Run from the repository root:
 *   npm run demo:autonomous-workflow
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AutonomousWorkflowRunner,
	createWorkflowAutomationPolicy,
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
	readonly #exitCodes = [0, 1, 0];
	#sequence = 0;

	start(input: StartJobProcessInput): JobProcess {
		const index = this.#sequence++;
		return new ShowcaseProcess(23_000 + index, input, this.#exitCodes[index] ?? 0);
	}
}

class RepairSession implements SubagentSession {
	readonly sessionId = "autonomous-repair-session";
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
			evidence: [{ path: "src/autonomous.ts", line: 1, note: "Failure corrected" }],
			architectureFindings: ["Controller remains the authoritative state owner"],
			changedFiles: ["src/autonomous.ts"],
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

class RepairSessionFactory implements SubagentSessionFactory {
	create(_config: SubagentSessionConfig): SubagentSession {
		return new RepairSession();
	}
}

const PLAN: PlanContent = {
	goal: "Demonstrate the automatic Workflow loop",
	assumptions: [],
	steps: [
		{
			id: "implement",
			kind: "command",
			command: "autonomous-implement",
			title: "Implement change",
			description: "Run the deterministic implementation command",
			dependsOn: [],
			fileIntents: [],
			verificationRequirementIds: ["implementation"],
		},
	],
	risks: [],
	verificationRequirements: [
		{
			id: "implementation",
			kind: "manual",
			description: "Implementation command completed",
			required: true,
		},
		{
			id: "tests",
			kind: "test",
			description: "Focused tests pass",
			command: "autonomous-test",
			required: true,
		},
	],
};

const workspace = mkdtempSync(join(tmpdir(), "pi-autonomous-workflow-showcase-"));
const sessions = SessionManager.inMemory(workspace);

try {
	const workflow = PlanWorkflowRuntime.start(sessions, {
		workflowId: "workflow-autonomous-showcase",
		rootTaskId: "task-autonomous-root",
		planId: "plan-autonomous-showcase",
		budget: { maxRetries: 2, maxConcurrentAgents: 1, maxConcurrentJobs: 1 },
		request: {
			text: "Demonstrate the automatic Workflow loop",
			cwd: workspace,
			attachments: [],
		},
	});
	workflow.submit(PLAN);
	console.log(`[approval] ${workflow.workflow.status}`);
	workflow.approve("Showcase approval");

	const jobs = new JobRuntime({
		processFactory: new ShowcaseProcessFactory(),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
	});
	const subagents = new SubagentRuntime({
		sessionFactory: new RepairSessionFactory(),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
	});
	const events: string[] = [];
	const runner = new AutonomousWorkflowRunner({
		runtime: workflow,
		subagentRuntime: subagents,
		jobRuntime: jobs,
		deliveryRuntime: new DeliveryRuntime({ jobRuntime: jobs }),
		policy: createWorkflowAutomationPolicy("auto", { maxConcurrency: 2 }),
		onEvent: (event) => {
			events.push(event.type);
			console.log(`[auto] ${event.type}`);
		},
	});

	const result = await runner.pump();
	if (!result.terminal || result.status !== "completed") {
		throw new Error(`Autonomous Workflow stopped in ${result.status}`);
	}
	if (!result.actions.some(({ kind }) => kind === "repair")) {
		throw new Error("Autonomous Workflow did not create the expected Repair");
	}
	if (!events.includes("workflow_verification_started") || !events.includes("workflow_repair_created")) {
		throw new Error("Autonomous Workflow did not emit verification and Repair events");
	}
	for (const line of workflow.finalReport?.lines ?? []) {
		console.log(line);
	}

	const recovered = PlanWorkflowRuntime.recoverLatest(sessions, {}, workflow.workflow.id);
	if (recovered?.workflow.status !== "completed") {
		throw new Error("Terminal autonomous Workflow recovery failed");
	}
	console.log(`[recovery] ${recovered.workflow.id}: ${recovered.workflow.status}`);
	console.log("[autonomous-showcase] PASS");
} finally {
	rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
