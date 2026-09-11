import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { BudgetLimit } from "./workflow/types.ts";

export interface CreatePlannerExecutorSessionOptions
	extends Omit<CreateAgentSessionOptions, "model" | "modelRouting" | "modelRoutingUserOverride" | "subagentRuntime"> {
	/** Fully qualified provider/model names, available to both the host and RPC children. */
	plannerModel: string;
	executorModel: string;
	workflowBudget?: BudgetLimit;
	/** Required external acceptance commands. No model-generated command is substituted. */
	verificationCommands: readonly string[];
}

/** Creates a Plan-mode host; execution stays behind explicit approval and uses serial RPC Workers. */
export async function createPlannerExecutorSession(
	options: CreatePlannerExecutorSessionOptions,
): Promise<CreateAgentSessionResult> {
	const { plannerModel, executorModel, workflowBudget, verificationCommands, ...sessionOptions } = options;
	for (const modelName of [plannerModel, executorModel]) {
		const separator = modelName.indexOf("/");
		if (modelName !== modelName.trim() || separator < 1 || separator === modelName.length - 1) {
			throw new Error("Planner/Executor models must use provider/model names");
		}
	}
	if (verificationCommands.length === 0 || verificationCommands.some((command) => !command.trim())) {
		throw new Error("Planner/Executor execution requires non-empty external verification commands");
	}
	// This entry point starts new work only; recovery needs an explicit cross-process contract.
	if (sessionOptions.sessionManager?.getEntries().some((entry) => entry.type !== "session_info")) {
		throw new Error("Planner/Executor execution requires a fresh session");
	}
	const result = await createAgentSession({
		...sessionOptions,
		tools: sessionOptions.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
		modelRoutingUserOverride: false,
		modelRouting: {
			enabled: true,
			policy: "planner_executor",
			fastModel: executorModel,
			balancedModel: plannerModel,
			strongModel: plannerModel,
			respectExplicitModel: true,
		},
	});
	try {
		for (const modelName of [plannerModel, executorModel]) {
			const separator = modelName.indexOf("/");
			const provider = modelName.slice(0, separator);
			if (
				!result.session.modelRuntime.getModel(provider, modelName.slice(separator + 1)) ||
				!result.session.modelRuntime.hasConfiguredAuth(provider)
			) {
				throw new Error(`Planner/Executor model ${modelName} is unavailable or unauthenticated`);
			}
		}
		result.session.enableWorkflowTracking(
			"plan",
			true,
			undefined,
			{
				...workflowBudget,
				maxConcurrentAgents: 1,
				maxConcurrentJobs: 1,
				maxRetries: workflowBudget?.maxRetries ?? 1,
			},
			verificationCommands,
		);
		return result;
	} catch (error) {
		result.session.dispose();
		throw error;
	}
}
