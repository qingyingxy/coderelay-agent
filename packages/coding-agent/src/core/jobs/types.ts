import type { AttemptId, EntityMetadata, IsoDateTime, JobId, TaskId, WorkflowId } from "../workflow/types.ts";

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "killed", "interrupted"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobTerminalStatus = Extract<JobStatus, "succeeded" | "failed" | "timed_out" | "killed" | "interrupted">;
export type JobLogStream = "stdout" | "stderr";

export interface Job extends EntityMetadata {
	readonly id: JobId;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly command: string;
	readonly cwd: string;
	readonly status: JobStatus;
	readonly pid?: number;
	readonly exitCode?: number;
	readonly startedAt?: IsoDateTime;
	readonly endedAt?: IsoDateTime;
	readonly timeoutMs: number;
	readonly stdoutRef: string;
	readonly stderrRef: string;
	readonly stdoutBytes: number;
	readonly stderrBytes: number;
	readonly retainedLogBytes: number;
	readonly logsTruncated: boolean;
	readonly reason?: string;
}

export interface JobLogChunk {
	readonly sequence: number;
	readonly jobId: JobId;
	readonly stream: JobLogStream;
	readonly text: string;
	readonly occurredAt: IsoDateTime;
}

export interface JobLogPage {
	readonly jobId: JobId;
	readonly chunks: readonly JobLogChunk[];
	readonly firstSequence: number;
	readonly nextSequence: number;
	readonly truncated: boolean;
}

export type JobEvent =
	| { readonly type: "job_queued"; readonly job: Job }
	| { readonly type: "job_started"; readonly job: Job }
	| { readonly type: "job_output"; readonly job: Job; readonly chunk: JobLogChunk }
	| { readonly type: "job_completed"; readonly job: Job };

export interface QueueJobInput {
	readonly id?: JobId;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
}

export interface JobProcessExit {
	readonly exitCode: number | null;
}

export interface JobProcess {
	readonly pid: number;
	wait(): Promise<JobProcessExit>;
	terminate(graceMs: number): Promise<void>;
}

export interface StartJobProcessInput {
	readonly command: string;
	readonly cwd: string;
	readonly onStdout: (text: string) => void;
	readonly onStderr: (text: string) => void;
}

export interface JobProcessFactory {
	start(input: StartJobProcessInput): JobProcess;
}
