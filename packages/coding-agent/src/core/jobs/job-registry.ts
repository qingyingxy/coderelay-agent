import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { WORKFLOW_SCHEMA_VERSION } from "../workflow/types.ts";
import type { Job, JobEvent, JobLogChunk, JobLogPage, JobStatus, QueueJobInput } from "./types.ts";

export interface JobRegistryOptions {
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly maxRetainedLogBytes?: number;
}

export type JobEventListener = (event: JobEvent) => void;

const TERMINAL_STATUSES = new Set<JobStatus>(["succeeded", "failed", "timed_out", "killed", "interrupted"]);

export class JobRegistry {
	readonly #jobs = new Map<string, Job>();
	readonly #logs = new Map<string, JobLogChunk[]>();
	readonly #listeners = new Set<JobEventListener>();
	readonly #now: () => number;
	readonly #createId: () => string;
	readonly #maxRetainedLogBytes: number;
	#nextLogSequence = 1;

	constructor(options: JobRegistryOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#createId = options.createId ?? randomUUID;
		this.#maxRetainedLogBytes = options.maxRetainedLogBytes ?? 256 * 1024;
		if (!Number.isInteger(this.#maxRetainedLogBytes) || this.#maxRetainedLogBytes < 1) {
			throw new Error("Job retained log limit must be a positive integer");
		}
	}

	queue(input: QueueJobInput): Job {
		if (!input.command.trim() || !input.cwd.trim()) {
			throw new Error("Job command and cwd are required");
		}
		if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
			throw new Error("Job timeout must be a positive integer");
		}
		const id = input.id ?? `job-${this.#createId()}`;
		if (this.#jobs.has(id)) {
			throw new Error(`Job ${id} already exists`);
		}
		const now = new Date(this.#now()).toISOString();
		const job: Job = {
			schemaVersion: WORKFLOW_SCHEMA_VERSION,
			revision: 0,
			createdAt: now,
			updatedAt: now,
			id,
			workflowId: input.workflowId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			command: input.command,
			cwd: input.cwd,
			status: "queued",
			timeoutMs: input.timeoutMs,
			stdoutRef: `job:${id}:stdout`,
			stderrRef: `job:${id}:stderr`,
			stdoutBytes: 0,
			stderrBytes: 0,
			retainedLogBytes: 0,
			logsTruncated: false,
		};
		this.#jobs.set(id, job);
		this.#logs.set(id, []);
		this.#emit({ type: "job_queued", job });
		return structuredClone(job);
	}

	get(jobId: string): Job | undefined {
		const job = this.#jobs.get(jobId);
		return job ? structuredClone(job) : undefined;
	}

	list(workflowId?: string): readonly Job[] {
		return [...this.#jobs.values()]
			.filter((job) => workflowId === undefined || job.workflowId === workflowId)
			.map((job) => structuredClone(job));
	}

	start(jobId: string, pid: number): Job {
		const job = this.#require(jobId);
		if (job.status !== "queued") {
			throw new Error(`Job ${jobId} cannot start from ${job.status}`);
		}
		if (!Number.isInteger(pid) || pid < 1) {
			throw new Error("Job PID must be a positive integer");
		}
		const startedAt = new Date(this.#now()).toISOString();
		const updated = this.#replace(job, { status: "running", pid, startedAt });
		this.#emit({ type: "job_started", job: updated });
		return structuredClone(updated);
	}

	append(jobId: string, stream: "stdout" | "stderr", value: string): JobLogChunk | undefined {
		const job = this.#require(jobId);
		if (job.status !== "running") {
			return undefined;
		}
		const text = sanitizeBinaryOutput(value);
		if (!text) {
			return undefined;
		}
		const chunk: JobLogChunk = {
			sequence: this.#nextLogSequence++,
			jobId,
			stream,
			text,
			occurredAt: new Date(this.#now()).toISOString(),
		};
		const logs = this.#logs.get(jobId) ?? [];
		logs.push(chunk);
		const observedBytes = Buffer.byteLength(text);
		const retained = this.#trimLogs(logs);
		this.#logs.set(jobId, retained.logs);
		const updated = this.#replace(job, {
			stdoutBytes: job.stdoutBytes + (stream === "stdout" ? observedBytes : 0),
			stderrBytes: job.stderrBytes + (stream === "stderr" ? observedBytes : 0),
			retainedLogBytes: retained.bytes,
			logsTruncated: job.logsTruncated || retained.truncated,
		});
		this.#emit({ type: "job_output", job: updated, chunk });
		return structuredClone(chunk);
	}

	finish(jobId: string, status: Exclude<JobStatus, "queued" | "running">, exitCode?: number, reason?: string): Job {
		const job = this.#require(jobId);
		if (TERMINAL_STATUSES.has(job.status)) {
			return structuredClone(job);
		}
		if (job.status === "queued" && status !== "failed" && status !== "killed" && status !== "interrupted") {
			throw new Error(`Queued Job ${jobId} cannot transition to ${status}`);
		}
		if (status === "succeeded" && exitCode !== 0) {
			throw new Error("Succeeded Job requires exit code 0");
		}
		const endedAt = new Date(this.#now()).toISOString();
		const updated = this.#replace(job, { status, exitCode, endedAt, reason });
		this.#emit({ type: "job_completed", job: updated });
		return structuredClone(updated);
	}

	logs(jobId: string, afterSequence = 0): JobLogPage {
		if (!Number.isInteger(afterSequence) || afterSequence < 0) {
			throw new Error("Job log cursor must be a non-negative integer");
		}
		const job = this.#require(jobId);
		const retained = this.#logs.get(jobId) ?? [];
		const chunks = retained.filter(({ sequence }) => sequence > afterSequence).map((chunk) => structuredClone(chunk));
		const firstSequence = retained[0]?.sequence ?? this.#nextLogSequence;
		return {
			jobId,
			chunks,
			firstSequence,
			nextSequence: (retained.at(-1)?.sequence ?? afterSequence) + 1,
			truncated: job.logsTruncated && afterSequence < firstSequence,
		};
	}

	subscribe(listener: JobEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#trimLogs(logs: JobLogChunk[]): { logs: JobLogChunk[]; bytes: number; truncated: boolean } {
		let bytes = logs.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0);
		let truncated = false;
		while (logs.length > 0 && bytes > this.#maxRetainedLogBytes) {
			const first = logs[0];
			if (!first) {
				break;
			}
			const firstBytes = Buffer.byteLength(first.text);
			const overflow = bytes - this.#maxRetainedLogBytes;
			if (firstBytes <= overflow) {
				logs.shift();
				bytes -= firstBytes;
			} else {
				const characters = Array.from(first.text);
				let removedBytes = 0;
				let removeCount = 0;
				while (removeCount < characters.length && removedBytes < overflow) {
					removedBytes += Buffer.byteLength(characters[removeCount] ?? "");
					removeCount++;
				}
				logs[0] = { ...first, text: characters.slice(removeCount).join("") };
				bytes -= removedBytes;
			}
			truncated = true;
		}
		return { logs, bytes, truncated };
	}

	#replace(job: Job, changes: Partial<Job>): Job {
		const updated: Job = {
			...job,
			...changes,
			revision: job.revision + 1,
			updatedAt: new Date(this.#now()).toISOString(),
		};
		this.#jobs.set(job.id, updated);
		return updated;
	}

	#require(jobId: string): Job {
		const job = this.#jobs.get(jobId);
		if (!job) {
			throw new Error(`Job ${jobId} does not exist`);
		}
		return job;
	}

	#emit(event: JobEvent): void {
		for (const listener of this.#listeners) {
			listener(structuredClone(event));
		}
	}
}
