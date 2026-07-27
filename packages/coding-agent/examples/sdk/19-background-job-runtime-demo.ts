/**
 * Background Job Runtime Demo
 *
 * Demonstrates a Command Task resource running without an LLM, incremental
 * stdout/stderr, lifecycle notifications, and the public Job control API.
 *
 * Run from the repository root:
 *   npm run demo:job-runtime
 */

import { formatJob, formatJobLogs, JobRuntime, WorkflowRuntimeRegistry } from "@earendil-works/pi-coding-agent";

const runtime = new JobRuntime({
	runtimeRegistry: new WorkflowRuntimeRegistry(),
	defaultTimeoutMs: 30_000,
});
const eventTypes: string[] = [];
runtime.registry.subscribe(({ type }) => eventTypes.push(type));
const job = runtime.queue({
	id: "job-demo",
	workflowId: "workflow-job-demo",
	taskId: "task-check",
	attemptId: "attempt-check",
	command: `node -e "process.stdout.write('check passed\\n');process.stderr.write('diagnostic\\n')"`,
	cwd: process.cwd(),
});
const result = await runtime.start(job.id);
const logLines = formatJobLogs(runtime.logs(job.id));

if (
	result.status !== "succeeded" ||
	result.exitCode !== 0 ||
	!logLines.some((line) => line.includes("stdout: check passed")) ||
	!logLines.some((line) => line.includes("stderr: diagnostic"))
) {
	throw new Error("Background Job Runtime demo failed");
}

console.log(`[job] ${formatJob(result)}`);
console.log(`[events] ${eventTypes.join(" -> ")}`);
for (const line of logLines) {
	console.log(`[log] ${line}`);
}
console.log("[demo] PASS");
