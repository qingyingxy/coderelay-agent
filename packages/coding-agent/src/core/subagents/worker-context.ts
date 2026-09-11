import type { Plan, Task } from "../workflow/types.ts";

export interface WorkerExecutionContract {
	readonly workflowId: string;
	readonly planId: string;
	readonly planVersion: number;
	readonly taskId: string;
	readonly attemptId: string;
	readonly goal: string;
	readonly taskTitle: string;
	readonly taskDescription: string;
	readonly assumptions: Plan["assumptions"];
	readonly risks: Plan["risks"];
	readonly step?: Plan["steps"][number];
	readonly verificationRequirements: Task["verificationRequirements"];
	readonly verificationCommands: readonly string[];
}

export function createWorkerExecutionContract(
	plan: Plan,
	task: Task,
	attemptId: string,
	verificationCommands: readonly string[],
): WorkerExecutionContract {
	if (plan.status !== "approved" || plan.workflowId !== task.workflowId) {
		throw new Error("Worker execution requires an approved Plan belonging to the Task");
	}
	return structuredClone({
		workflowId: plan.workflowId,
		planId: plan.id,
		planVersion: plan.version,
		taskId: task.id,
		attemptId,
		goal: plan.goal,
		taskTitle: task.title,
		taskDescription: task.description,
		assumptions: plan.assumptions,
		risks: plan.risks,
		step: plan.steps.find(({ id }) => id === task.sourcePlanStepId),
		verificationRequirements: task.verificationRequirements,
		verificationCommands,
	});
}

export function formatWorkerExecutionContext(contract: WorkerExecutionContract): string {
	const serialized = JSON.stringify(contract);
	// Do not silently truncate a file boundary or acceptance requirement in the fixed context.
	if (Buffer.byteLength(serialized, "utf8") > 12_000) {
		throw new Error("Worker execution contract exceeds 12000 bytes; split the planned Task");
	}
	return [
		`Parent execution contract (fixed for this Attempt): ${serialized}`,
		"This parent contract remains in the system context across new_context cuts. Do not replan or change its identity, scope, or acceptance requirements.",
		"The fixed contract describes the original task, not a reset checklist. A runtime context-window receipt proves completed cuts even if your handoff omitted them. Do not repeat an already completed one-off cut; continue the remaining work.",
		"The local Direct Workflow Snapshot tracks this child Session, not the parent Plan. Parent acceptance remains pending until the parent runtime verifies it. Notes, handoffs, and local completion are not parent verification evidence.",
		"Before new_context, record modified files, unfinished work, and unverified requirements in notes or its handoff argument. After a cut continue the same Attempt and model; use history for exact earlier evidence. Report plan conflicts instead of silently widening scope.",
	].join("\n");
}
