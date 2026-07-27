import type { Job, JobLogPage } from "./types.ts";

export function formatJob(job: Job): string {
	const exit = job.exitCode === undefined ? "" : ` | exit ${job.exitCode}`;
	const pid = job.pid === undefined ? "" : ` | pid ${job.pid}`;
	return `${job.id} | ${job.status}${pid}${exit} | ${job.command}`;
}

export function formatJobs(jobs: readonly Job[]): readonly string[] {
	return jobs.length === 0 ? ["No jobs"] : jobs.map(formatJob);
}

export function formatJobLogs(page: JobLogPage): readonly string[] {
	const lines = page.chunks.map(
		({ sequence, stream, text }) => `[${sequence}] ${stream}: ${text.replace(/\s+$/, "")}`,
	);
	return page.truncated ? [`[logs truncated before ${page.firstSequence}]`, ...lines] : lines;
}
