/**
 * Delivery and Recovery Demo
 *
 * Demonstrates Command Task execution, workflow-level Test verification,
 * Completion Gate, terminal reporting, Snapshot persistence, and replay.
 *
 * Run from the repository root:
 *   npm run demo:delivery-recovery
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
	SessionManager,
	type StartJobProcessInput,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "@earendil-works/pi-coding-agent";

class DemoProcess implements JobProcess {
	readonly pid: number;
	readonly #input: StartJobProcessInput;

	constructor(pid: number, input: StartJobProcessInput) {
		this.pid = pid;
		this.#input = input;
	}

	async wait(): Promise<JobProcessExit> {
		this.#input.onStdout(`${this.#input.command}: passed\n`);
		return { exitCode: 0 };
	}

	async terminate(): Promise<void> {}
}

class DemoProcessFactory implements JobProcessFactory {
	#sequence = 0;

	start(input: StartJobProcessInput): JobProcess {
		return new DemoProcess(10_000 + ++this.#sequence, input);
	}
}

const workspace = mkdtempSync(join(tmpdir(), "pi-delivery-recovery-demo-"));
const sessionManager = SessionManager.inMemory(workspace);
const content: PlanContent = {
	goal: "Implement and verify a deterministic CLI change",
	assumptions: [],
	steps: [
		{
			id: "implement",
			kind: "command",
			command: "demo-implement",
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
			description: "Implementation command succeeds",
			required: true,
		},
		{
			id: "tests",
			kind: "test",
			description: "Focused tests pass",
			command: "demo-test",
			required: true,
		},
	],
};

try {
	const workflow = PlanWorkflowRuntime.start(sessionManager, {
		workflowId: "workflow-delivery-demo",
		rootTaskId: "task-root",
		planId: "plan-delivery-demo",
		request: {
			text: "Implement and verify a deterministic CLI change",
			cwd: workspace,
			attachments: [],
		},
	});
	workflow.submit(content);
	workflow.approve("Demo approval");

	const jobs = new JobRuntime({
		processFactory: new DemoProcessFactory(),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
	});
	const [implementation] = await workflow.startReadyJobs(jobs, 1);
	await implementation?.completion;

	const delivery = new DeliveryRuntime({
		jobRuntime: jobs,
		writerLeaseRegistry: new WriterLeaseRegistry(),
	});
	const result = await delivery.run(workflow);
	if (result.status !== "completed" || workflow.workflow.status !== "completed") {
		throw new Error("Completion Gate did not complete the Workflow");
	}

	const recovered = PlanWorkflowRuntime.recoverLatest(sessionManager, {}, workflow.workflow.id);
	if (!recovered || recovered.workflow.status !== "completed") {
		throw new Error("Snapshot and Event replay did not recover the terminal Workflow");
	}
	if (!recovered.verifications.some(({ requirementId, status }) => requirementId === "tests" && status === "passed")) {
		throw new Error("Recovered Workflow is missing the passed Test result");
	}

	for (const line of recovered.statusLines) {
		console.log(line);
	}
	console.log("[recovery] terminal Workflow restored from Snapshot + Event Log");
	console.log("[demo] PASS");
} finally {
	rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
