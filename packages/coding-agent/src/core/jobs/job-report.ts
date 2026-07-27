import type { Job, JobLogPage } from "./types.ts";

export function formatJob(job: Job): string {
	const exit = job.exitCode === undefined ? "" : ` | exit ${job.exitCode}`;
	const pid = job.pid === undefined ? "" : ` | pid ${job.pid}`;
	const reason = job.reason ? ` | reason ${job.reason}` : "";
	return `${job.id} | ${job.status} | task ${job.taskId} | attempt ${job.attemptId}${pid}${exit}${reason} | ${job.command}`;
}

export function formatJobs(jobs: readonly Job[]): readonly string[] {
	return jobs.length === 0 ? ["Jobs: (none)"] : [`Jobs: ${jobs.length}`, ...jobs.map(formatJob)];
}

export function formatJobLogs(page: JobLogPage): readonly string[] {
	const lines = page.chunks.map(
		({ sequence, stream, text }) => `[${sequence}] ${stream}: ${text.replace(/\s+$/, "")}`,
	);
	return page.truncated ? [`[logs truncated before ${page.firstSequence}]`, ...lines] : lines;
}
