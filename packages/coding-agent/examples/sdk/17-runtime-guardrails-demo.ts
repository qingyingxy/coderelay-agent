/**
 * Runtime Guardrails Demo
 *
 * Demonstrates permission intersection, budget warnings and hard limits,
 * cross-process Writer exclusion, and runtime-resource cascade cancellation.
 *
 * Run from the repository root:
 *   npm run demo:runtime-guardrails
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluateBudget,
	FULL_PERMISSION_SET,
	filterToolsByPermissions,
	formatBudgetEvaluation,
	resolveEffectivePermissions,
	WorkflowRuntimeRegistry,
	WriterLeaseError,
	WriterLeaseRegistry,
} from "@earendil-works/pi-coding-agent";

const effectivePermissions = resolveEffectivePermissions({
	parent: FULL_PERMISSION_SET,
	profile: {
		...FULL_PERMISSION_SET,
		write: false,
		executeCommands: false,
		network: false,
	},
	workflow: FULL_PERMISSION_SET,
	task: FULL_PERMISSION_SET,
});
const permittedTools = filterToolsByPermissions(["read", "grep", "edit", "write", "bash"], effectivePermissions);
if (permittedTools.join(",") !== "read,grep") {
	throw new Error("Read-only permission intersection failed");
}

const usage = {
	inputTokens: 800,
	outputTokens: 100,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0.8,
	turns: 8,
	durationMs: 8_000,
};
const warning = evaluateBudget({ maxInputTokens: 1_000, maxTurns: 10 }, usage);
const exceeded = evaluateBudget({ maxCost: 0.8 }, usage);
if (warning.warnings.length !== 2 || exceeded.exceeded.length !== 1) {
	throw new Error("Budget guardrail evaluation failed");
}

const leaseDirectory = mkdtempSync(join(tmpdir(), "pi-runtime-guardrails-"));
try {
	const firstProcess = new WriterLeaseRegistry({
		createId: () => "writer-lease-1",
		storageDirectory: leaseDirectory,
	});
	const secondProcess = new WriterLeaseRegistry({
		createId: () => "writer-lease-2",
		storageDirectory: leaseDirectory,
	});
	const lease = firstProcess.acquire({
		workspace: "C:/demo-workspace",
		workflowId: "workflow-1",
		taskId: "writer-task-1",
		ttlMs: 60_000,
	});
	let secondWriterRejected = false;
	try {
		secondProcess.acquire({
			workspace: "C:/demo-workspace",
			workflowId: "workflow-2",
			taskId: "writer-task-2",
			ttlMs: 60_000,
		});
	} catch (error) {
		secondWriterRejected = error instanceof WriterLeaseError;
	}
	if (!secondWriterRejected) {
		throw new Error("Expected the second Writer to be rejected");
	}
	firstProcess.release(lease.id);
} finally {
	rmSync(leaseDirectory, { recursive: true, force: true });
}

const runtimeRegistry = new WorkflowRuntimeRegistry();
const stopped: string[] = [];
for (const [id, kind] of [
	["agent-1", "agent"],
	["job-1", "job"],
] as const) {
	runtimeRegistry.register({
		id,
		kind,
		workflowId: "workflow-1",
		taskId: `${kind}-task`,
		stop: async (reason) => {
			stopped.push(`${id}:${reason}`);
		},
	});
}
const cancellation = await runtimeRegistry.cancelWorkflow("workflow-1", "demo cancellation");
if (cancellation.failures.length > 0 || cancellation.stoppedResourceIds.length !== 2) {
	throw new Error("Cascade cancellation failed");
}

console.log(`[permissions] ${permittedTools.join(", ")}`);
console.log(`[budget] ${formatBudgetEvaluation(warning)}`);
console.log(`[budget] ${formatBudgetEvaluation(exceeded)}`);
console.log("[writer] second Writer rejected");
console.log(`[cancel] ${stopped.join(", ")}`);
console.log("[demo] PASS");
