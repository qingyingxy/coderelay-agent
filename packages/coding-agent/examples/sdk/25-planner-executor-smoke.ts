import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { digestProtectedPaths } from "../../src/core/evaluation/integrity.ts";
import {
	createAgentSession,
	createPlannerExecutorSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../src/index.ts";

// Explicit arm selection prevents accidentally repeating a paid baseline after a failed candidate.
const arm = process.argv[2];
const destination = process.argv[3];
if ((arm !== "baseline" && arm !== "candidate") || !destination) {
	throw new Error("Usage: tsx 25-planner-executor-smoke.ts baseline|candidate NEW_OUTPUT_DIRECTORY");
}
const output = resolve(destination);
mkdirSync(output, { recursive: false });
const workspace = mkdtempSync(join(tmpdir(), `pi-planner-executor-${arm}-`));
cpSync(resolve("packages/coding-agent/evals/r16/fixtures/counter-store-invariants"), workspace, {
	recursive: true,
});
const protectedDigest = digestProtectedPaths(workspace, ["test", "package.json"]);
const preflight = spawnSync(process.execPath, ["--test"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
if (preflight.status === 0 || preflight.error) throw new Error("Expected defective fixture to fail tests");
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("qingyingxy", "gpt-5.6-sol");
if (!model) throw new Error("Configured strong model unavailable");
const settingsManager = SettingsManager.inMemory();
const resourceLoader = new DefaultResourceLoader({
	cwd: workspace,
	agentDir: getAgentDir(),
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await resourceLoader.reload();
const options = {
	cwd: workspace,
	modelRuntime,
	settingsManager,
	resourceLoader,
	sessionManager: SessionManager.create(workspace, join(output, "sessions")),
	thinkingLevel: "medium" as const,
};
const { session } =
	arm === "candidate"
		? await createPlannerExecutorSession({
				...options,
				plannerModel: "qingyingxy/gpt-5.6-sol",
				executorModel: "qingyingxy/gpt-5.6-luna",
				verificationCommands: ["node --test"],
				workflowBudget: { maxCost: 1, maxDurationMs: 600_000, maxRetries: 1 },
			})
		: await createAgentSession({ ...options, model, tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] });
if (arm === "baseline") session.enableWorkflowTracking("direct", false);
const startedAt = Date.now();
let failure: string | undefined;
let stopped = false;
let cancellation: Promise<unknown> | undefined;
function cost() {
	const agents = new Map(session.getWorkflowView()?.agents.map((agent) => [agent.id, agent]) ?? []);
	return session.getSessionStats().cost + [...agents.values()].reduce((sum, agent) => sum + agent.usage.cost, 0);
}
const timer = setInterval(() => {
	if (stopped || (cost() < 1 && Date.now() - startedAt < 600_000)) return;
	stopped = true;
	failure = "Cost or duration stop threshold reached; in-flight usage can overshoot";
	cancellation = session.abort().then(() => session.cancelWorkflow(failure!));
}, 250);
try {
	const prompt =
		"Fix only atomic rejection of an excessive decrement: when amount exceeds the current value, throw without changing value or notifying subscribers. Valid decrements must still commit and then notify. " +
		"For this fixture, initialValue and amount are finite non-negative numbers and subscribers are valid non-throwing functions. Validation of other inputs, subscriber errors, and broader counter-library hardening are outside this task. " +
		"Keep the exported API stable. Only modify src/counter-store.mjs. Do not modify test or package.json. Run node --test. " +
		(arm === "candidate"
			? "Plan exactly one serial worker task. Require the worker to read the code, call new_context exactly once with an empty argument object, then continue from the deterministic Workflow Snapshot and Workspace state to implement and run node --test. After the cut, its runtime receipt means the one-off cut requirement is complete; do not repeat it. Include this explicit cut requirement in the worker task description."
			: "Implement directly without delegating to subagents.");
	await session.prompt(prompt);
	if (arm === "candidate") {
		while (!stopped) {
			const view = session.getWorkflowView();
			if (!view || ["completed", "failed", "cancelled"].includes(view.workflow.status)) break;
			if (view.workflow.status === "awaiting_approval") {
				const steps = view.plan?.steps ?? [];
				const workers = steps.filter((step) => step.kind === "agent" && step.requiredAgentRole === "worker");
				const worker = workers[0];
				if (
					workers.length !== 1 ||
					!worker ||
					worker.dependsOn.length !== 0 ||
					!worker.description.includes("new_context") ||
					worker.fileIntents.some(
						(intent) => intent.action !== "inspect" && intent.path !== "src/counter-store.mjs",
					) ||
					steps.some(
						(step) =>
							step !== worker &&
							(step.kind !== "command" ||
								step.command !== "node --test" ||
								!step.dependsOn.includes(worker.id) ||
								step.fileIntents.some((intent) => intent.action !== "inspect")),
					)
				)
					throw new Error("Plan violates fixed single-worker smoke protocol; not approved");
				session.decideWorkflowPlan("approve", "Approved under fixed single-fixture smoke protocol");
			}
			const result = await session.waitForWorkflowAutomation();
			if (result?.terminal) break;
			if (result?.waitingReason && !["awaiting_approval", "active_resources"].includes(result.waitingReason)) {
				throw new Error(`Workflow stalled: ${result.waitingReason}`);
			}
			await delay(100);
		}
	}
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
} finally {
	clearInterval(timer);
	await cancellation;
	if (failure) {
		await session.abort();
		await session.cancelWorkflow(failure);
	}
	const view = session.getWorkflowView();
	if (!failure && arm === "candidate" && view?.workflow.status !== "completed") {
		failure = view?.stopReason ?? `Workflow did not complete: ${view?.workflow.status ?? "missing"}`;
	}
	const childEvidence = [];
	const workerDir = join(getAgentDir(), "sessions", "workers");
	const workerFiles = existsSync(workerDir) ? readdirSync(workerDir) : [];
	for (const agent of view?.agents ?? []) {
		if (!agent.sessionId) continue;
		const file = workerFiles.find((name) => name.endsWith(`${agent.sessionId}.jsonl`));
		if (!file) continue;
		const entries = SessionManager.open(join(workerDir, file)).getEntries();
		childEvidence.push({
			agentId: agent.id,
			model: agent.modelRoute?.modelName,
			cuts: entries.filter((entry) => entry.type === "context_window").length,
		});
		cpSync(join(workerDir, file), join(output, file));
	}
	const verification = spawnSync(process.execPath, ["--test"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
	const protectedPathsUnchanged = protectedDigest === digestProtectedPaths(workspace, ["test", "package.json"]);
	const totalCuts = childEvidence.reduce((sum, child) => sum + child.cuts, 0);
	if (!failure && arm === "candidate" && totalCuts !== 1)
		failure = `Expected exactly one smoke cut; observed ${totalCuts}`;
	const passed =
		!failure &&
		verification.status === 0 &&
		protectedPathsUnchanged &&
		(arm === "baseline" || (view?.workflow.status === "completed" && totalCuts === 1));
	const report = {
		protocolVersion: "counter-atomicity-v2",
		arm,
		passed,
		failure,
		workspace,
		durationMs: Date.now() - startedAt,
		estimatedCost: cost(),
		protectedPathsUnchanged,
		childEvidence,
		host: session.getSessionStats(),
		workflow: view,
		verification: { status: verification.status, stdout: verification.stdout, stderr: verification.stderr },
		limitations: [
			"Single tiny fixture with forced cut; not evidence of statistical cost savings",
			"Costs use configured model rates, not provider billing; thresholds are not hard billing caps",
			"Serial non-Git temporary workspace; no worktree isolation tested",
		],
	};
	writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
	cpSync(workspace, join(output, "workspace"), { recursive: true });
	session.dispose();
	console.log(
		JSON.stringify({
			arm,
			passed,
			failure,
			estimatedCost: report.estimatedCost,
			durationMs: report.durationMs,
			childEvidence,
			output,
		}),
	);
	if (!passed) process.exitCode = 1;
}
