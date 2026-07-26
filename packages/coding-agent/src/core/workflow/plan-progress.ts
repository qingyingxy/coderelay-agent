import type { Plan, PlanProgress, Task } from "./types.ts";

export function derivePlanProgress(plan: Plan, tasks: readonly Task[]): PlanProgress {
	const tasksByStepId = new Map(
		tasks
			.filter((task) => task.sourcePlanId === plan.id && task.sourcePlanStepId)
			.map((task) => [task.sourcePlanStepId as string, task]),
	);
	let pendingSteps = 0;
	let runningSteps = 0;
	let succeededSteps = 0;
	let failedSteps = 0;
	let cancelledSteps = 0;

	for (const step of plan.steps) {
		const status = tasksByStepId.get(step.id)?.status;
		switch (status) {
			case "running":
			case "verifying":
				runningSteps++;
				break;
			case "succeeded":
				succeededSteps++;
				break;
			case "failed":
				failedSteps++;
				break;
			case "cancelled":
				cancelledSteps++;
				break;
			default:
				pendingSteps++;
				break;
		}
	}

	return {
		planId: plan.id,
		totalSteps: plan.steps.length,
		pendingSteps,
		runningSteps,
		succeededSteps,
		failedSteps,
		cancelledSteps,
		percentComplete: plan.steps.length === 0 ? 0 : Math.floor((succeededSteps / plan.steps.length) * 100),
	};
}
