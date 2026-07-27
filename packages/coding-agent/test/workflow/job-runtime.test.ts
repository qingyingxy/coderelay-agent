import { describe, expect, it, vi } from "vitest";
import {
	type JobProcess,
	type JobProcessExit,
	type JobProcessFactory,
	JobRegistry,
	JobRuntime,
	type StartJobProcessInput,
	WorkflowRuntimeRegistry,
} from "../../src/index.ts";

class FakeJobProcess implements JobProcess {
	readonly pid: number;
	readonly #stdout: (text: string) => void;
	readonly #stderr: (text: string) => void;
	readonly #completion: Promise<JobProcessExit>;
	#resolve!: (exit: JobProcessExit) => void;
	terminateCalls = 0;

	constructor(pid: number, input: StartJobProcessInput) {
		this.pid = pid;
		this.#stdout = input.onStdout;
		this.#stderr = input.onStderr;
		this.#completion = new Promise((resolve) => {
			this.#resolve = resolve;
		});
	}

	output(stdout: string, stderr = ""): void {
		if (stdout) this.#stdout(stdout);
		if (stderr) this.#stderr(stderr);
	}

	exit(exitCode: number | null): void {
		this.#resolve({ exitCode });
	}

	wait(): Promise<JobProcessExit> {
		return this.#completion;
	}

	async terminate(): Promise<void> {
		this.terminateCalls++;
		this.exit(null);
	}
}

class FakeJobProcessFactory implements JobProcessFactory {
	readonly processes: FakeJobProcess[] = [];

	start(input: StartJobProcessInput): JobProcess {
		const process = new FakeJobProcess(1000 + this.processes.length, input);
		this.processes.push(process);
		return process;
	}
}

function queue(runtime: JobRuntime, overrides: Partial<Parameters<JobRuntime["queue"]>[0]> = {}) {
	return runtime.queue({
		id: "job-1",
		workflowId: "workflow-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		command: "npm run check",
		cwd: "C:/repo",
		timeoutMs: 10_000,
		...overrides,
	});
}

describe("JobRuntime", () => {
	it("streams separate output, emits completion, and preserves the successful exit", async () => {
		const factory = new FakeJobProcessFactory();
		const registry = new JobRegistry();
		const events: string[] = [];
		registry.subscribe(({ type }) => events.push(type));
		const runtime = new JobRuntime({
			registry,
			processFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const job = queue(runtime);
		const completion = runtime.start(job.id);
		factory.processes[0]?.output("checking\n", "warning\n");
		factory.processes[0]?.exit(0);

		await expect(completion).resolves.toMatchObject({ status: "succeeded", exitCode: 0 });
		expect(runtime.logs(job.id).chunks).toMatchObject([
			{ stream: "stdout", text: "checking\n" },
			{ stream: "stderr", text: "warning\n" },
		]);
		expect(events).toEqual(["job_queued", "job_started", "job_output", "job_output", "job_completed"]);
	});

	it("limits retained logs to the tail and supports incremental cursors", async () => {
		const factory = new FakeJobProcessFactory();
		const runtime = new JobRuntime({
			registry: new JobRegistry({ maxRetainedLogBytes: 8 }),
			processFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const job = queue(runtime);
		const completion = runtime.start(job.id);
		factory.processes[0]?.output("12345");
		factory.processes[0]?.output("67890");
		factory.processes[0]?.exit(0);
		await completion;

		const page = runtime.logs(job.id);
		expect(page.truncated).toBe(true);
		expect(page.chunks.map(({ text }) => text).join("")).toBe("34567890");
		expect(runtime.logs(job.id, page.chunks[0]?.sequence).chunks).toHaveLength(1);
	});

	it("times out once, terminates the process tree abstraction, and ignores the late exit", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeJobProcessFactory();
			const runtime = new JobRuntime({
				processFactory: factory,
				runtimeRegistry: new WorkflowRuntimeRegistry(),
				terminationGraceMs: 1,
			});
			const job = queue(runtime, { timeoutMs: 20 });
			const completion = runtime.start(job.id);
			await vi.advanceTimersByTimeAsync(20);

			await expect(completion).resolves.toMatchObject({ status: "timed_out" });
			expect(factory.processes[0]?.terminateCalls).toBe(1);
			factory.processes[0]?.exit(0);
			expect(runtime.registry.get(job.id)?.status).toBe("timed_out");
		} finally {
			vi.useRealTimers();
		}
	});

	it("makes concurrent kill idempotent and cascades Workflow cancellation", async () => {
		const factory = new FakeJobProcessFactory();
		const runtime = new JobRuntime({
			processFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const first = queue(runtime);
		const second = queue(runtime, {
			id: "job-2",
			taskId: "task-2",
			attemptId: "attempt-2",
		});
		const firstCompletion = runtime.start(first.id);
		const secondCompletion = runtime.start(second.id);
		await Promise.all([runtime.kill(first.id), runtime.kill(first.id)]);
		await runtime.cancelWorkflow("workflow-1", "Workflow cancelled");

		expect((await firstCompletion).status).toBe("killed");
		expect((await secondCompletion).status).toBe("interrupted");
		expect(factory.processes.map(({ terminateCalls }) => terminateCalls)).toEqual([1, 1]);
	});

	it("rejects invalid limits and exposes available execution slots", async () => {
		expect(() => new JobRuntime({ maxConcurrentJobs: 0 })).toThrow("positive integer");
		const factory = new FakeJobProcessFactory();
		const runtime = new JobRuntime({
			processFactory: factory,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			maxConcurrentJobs: 1,
		});
		const job = queue(runtime);
		const completion = runtime.start(job.id);
		expect(runtime.availableSlots).toBe(0);
		factory.processes[0]?.exit(0);
		await completion;
		expect(runtime.availableSlots).toBe(1);
	});

	it("runs a real local background process with separate stdout and stderr", async () => {
		const runtime = new JobRuntime({
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const job = queue(runtime, {
			cwd: process.cwd(),
			command: `node -e "process.stdout.write('job-out');process.stderr.write('job-err')"`,
		});

		await expect(runtime.start(job.id)).resolves.toMatchObject({ status: "succeeded", exitCode: 0 });
		expect(runtime.logs(job.id).chunks).toMatchObject([
			{ stream: "stdout", text: "job-out" },
			{ stream: "stderr", text: "job-err" },
		]);
	});

	it("times out and cleans up a real local process tree", async () => {
		const runtime = new JobRuntime({
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			terminationGraceMs: 100,
		});
		const job = queue(runtime, {
			cwd: process.cwd(),
			timeoutMs: 100,
			command: `node -e "setInterval(() => {}, 1000)"`,
		});

		await expect(runtime.start(job.id)).resolves.toMatchObject({ status: "timed_out" });
	}, 10_000);
});
