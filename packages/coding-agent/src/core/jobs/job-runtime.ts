import { DEFAULT_WORKFLOW_RUNTIME_REGISTRY, type WorkflowRuntimeRegistry } from "../workflow/runtime-registry.ts";
import type { JobId, WorkflowId } from "../workflow/types.ts";
import { JobRegistry } from "./job-registry.ts";
import { LocalJobProcessFactory } from "./local-job-process.ts";
import type { Job, JobLogPage, JobProcess, JobProcessFactory, JobTerminalStatus, QueueJobInput } from "./types.ts";

export interface JobRuntimeOptions {
	readonly registry?: JobRegistry;
	readonly processFactory?: JobProcessFactory;
	readonly runtimeRegistry?: WorkflowRuntimeRegistry;
	readonly defaultTimeoutMs?: number;
	readonly terminationGraceMs?: number;
	readonly maxConcurrentJobs?: number;
}

interface ActiveJob {
	readonly process: JobProcess;
	readonly completion: Promise<Job>;
	readonly unregister: () => void;
	termination?: Promise<void>;
}

export class JobRuntime {
	readonly registry: JobRegistry;
	readonly #processFactory: JobProcessFactory;
	readonly #runtimeRegistry: WorkflowRuntimeRegistry;
	readonly #defaultTimeoutMs: number;
	readonly #terminationGraceMs: number;
	readonly #maxConcurrentJobs: number;
	readonly #active = new Map<JobId, ActiveJob>();
	readonly #completions = new Map<JobId, Promise<Job>>();

	constructor(options: JobRuntimeOptions = {}) {
		this.registry = options.registry ?? new JobRegistry();
		this.#processFactory = options.processFactory ?? new LocalJobProcessFactory();
		this.#runtimeRegistry = options.runtimeRegistry ?? DEFAULT_WORKFLOW_RUNTIME_REGISTRY;
		this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60_000;
		this.#terminationGraceMs = options.terminationGraceMs ?? 1_000;
		this.#maxConcurrentJobs = options.maxConcurrentJobs ?? 4;
		if (!Number.isInteger(this.#maxConcurrentJobs) || this.#maxConcurrentJobs < 1) {
			throw new Error("Job concurrency limit must be a positive integer");
		}
	}

	get availableSlots(): number {
		return Math.max(0, this.#maxConcurrentJobs - this.#active.size);
	}

	queue(input: Omit<QueueJobInput, "timeoutMs"> & { readonly timeoutMs?: number }): Job {
		return this.registry.queue({
			...input,
			timeoutMs: input.timeoutMs ?? this.#defaultTimeoutMs,
		});
	}

	start(jobId: JobId): Promise<Job> {
		const job = this.#require(jobId);
		if (job.status !== "queued") {
			throw new Error(`Job ${jobId} cannot start from ${job.status}`);
		}
		if (this.#active.size >= this.#maxConcurrentJobs) {
			throw new Error(`Job concurrency limit ${this.#maxConcurrentJobs} reached`);
		}
		let processHandle: JobProcess;
		try {
			processHandle = this.#processFactory.start({
				command: job.command,
				cwd: job.cwd,
				onStdout: (text) => this.registry.append(jobId, "stdout", text),
				onStderr: (text) => this.registry.append(jobId, "stderr", text),
			});
		} catch (error) {
			const failed = this.registry.finish(
				jobId,
				"failed",
				undefined,
				error instanceof Error ? error.message : String(error),
			);
			const completion = Promise.resolve(failed);
			this.#completions.set(jobId, completion);
			return completion;
		}
		let unregister: () => void;
		try {
			this.registry.start(jobId, processHandle.pid);
			unregister = this.#runtimeRegistry.register({
				id: `job:${job.workflowId}:${jobId}`,
				kind: "job",
				workflowId: job.workflowId,
				taskId: job.taskId,
				stop: (reason) => this.kill(jobId, reason),
			});
		} catch (error) {
			const failed = this.registry.finish(
				jobId,
				"failed",
				undefined,
				error instanceof Error ? error.message : String(error),
			);
			const completion = processHandle
				.terminate(this.#terminationGraceMs)
				.catch(() => undefined)
				.then(() => failed);
			this.#completions.set(jobId, completion);
			return completion;
		}
		let timeout: NodeJS.Timeout | undefined;
		const processCompletion = Promise.resolve()
			.then(() => processHandle.wait())
			.then(({ exitCode }) =>
				this.registry.finish(
					jobId,
					exitCode === 0 ? "succeeded" : "failed",
					exitCode ?? undefined,
					exitCode === 0 ? undefined : `Command exited with code ${exitCode ?? "unknown"}`,
				),
			)
			.catch((error) =>
				this.registry.finish(jobId, "failed", undefined, error instanceof Error ? error.message : String(error)),
			)
			.finally(() => {
				if (timeout) {
					clearTimeout(timeout);
				}
				unregister();
				this.#active.delete(jobId);
			});
		const active: ActiveJob = { process: processHandle, completion: processCompletion, unregister };
		this.#active.set(jobId, active);
		this.#completions.set(jobId, processCompletion);
		timeout = setTimeout(() => {
			void this.#terminate(jobId, "timed_out", `Timed out after ${job.timeoutMs}ms`);
		}, job.timeoutMs);
		return processCompletion;
	}

	jobs(workflowId?: WorkflowId): readonly Job[] {
		return this.registry.list(workflowId);
	}

	logs(jobId: JobId, afterSequence = 0): JobLogPage {
		return this.registry.logs(jobId, afterSequence);
	}

	wait(jobId: JobId): Promise<Job> {
		const completion = this.#completions.get(jobId);
		if (completion) {
			return completion;
		}
		const job = this.#require(jobId);
		if (job.status === "queued") {
			throw new Error(`Job ${jobId} has not started`);
		}
		return Promise.resolve(job);
	}

	kill(jobId: JobId, reason = "Job killed"): Promise<void> {
		return this.#terminate(jobId, "killed", reason);
	}

	async cancelWorkflow(workflowId: WorkflowId, reason: string): Promise<void> {
		await Promise.all(
			this.registry
				.list(workflowId)
				.filter(({ status }) => status === "queued" || status === "running")
				.map(({ id }) => this.#terminate(id, "interrupted", reason)),
		);
	}

	async #terminate(
		jobId: JobId,
		status: Extract<JobTerminalStatus, "timed_out" | "killed" | "interrupted">,
		reason: string,
	) {
		const job = this.#require(jobId);
		if (job.status === "queued") {
			this.registry.finish(jobId, status, undefined, reason);
			return;
		}
		if (job.status !== "running") {
			return;
		}
		const active = this.#active.get(jobId);
		if (!active) {
			this.registry.finish(jobId, status, undefined, reason);
			return;
		}
		if (!active.termination) {
			this.registry.finish(jobId, status, undefined, reason);
			active.termination = active.process.terminate(this.#terminationGraceMs).then(() => undefined);
		}
		await active.termination;
	}

	#require(jobId: JobId): Job {
		const job = this.registry.get(jobId);
		if (!job) {
			throw new Error(`Job ${jobId} does not exist`);
		}
		return job;
	}
}
