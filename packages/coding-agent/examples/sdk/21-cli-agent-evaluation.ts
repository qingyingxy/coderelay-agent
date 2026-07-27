/**
 * Deterministic CLI Agent Evaluation
 *
 * Exercises fixed repository-task scenarios without provider calls or paid tokens.
 *
 * Run from the repository root:
 *   npm run eval:cli-agent
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	adviseExecutionMode,
	type PlanContent,
	PlanWorkflowRuntime,
	type ResolvedExecutionMode,
	SessionManager,
	selectExecutionMode,
} from "@earendil-works/pi-coding-agent";

interface ModeCase {
	readonly id: string;
	readonly task: string;
	readonly complexity: "low" | "medium" | "high";
	readonly riskLevel: "low" | "medium" | "high";
	readonly expectedMode: ResolvedExecutionMode;
}

interface EvaluationResult {
	readonly id: string;
	readonly passed: boolean;
	readonly detail: string;
}

const MODE_CASES: readonly ModeCase[] = [
	{
		id: "localized-readme-fix",
		task: "Correct one typo in the CLI README",
		complexity: "low",
		riskLevel: "low",
		expectedMode: "direct",
	},
	{
		id: "workflow-state-refactor",
		task: "Refactor Workflow state transitions across controller, store, and recovery",
		complexity: "high",
		riskLevel: "medium",
		expectedMode: "plan",
	},
	{
		id: "destructive-cli-migration",
		task: "Migrate persisted CLI sessions with destructive schema changes",
		complexity: "medium",
		riskLevel: "high",
		expectedMode: "plan",
	},
];

const PLAN_CONTENT: PlanContent = {
	goal: "Add a dependency-aware CLI command",
	assumptions: ["The existing command registry remains authoritative"],
	steps: [
		{
			id: "implement",
			title: "Implement command",
			description: "Add the command and its state transition",
			dependsOn: [],
			fileIntents: [{ path: "src/commands.ts", action: "modify", reason: "Add command" }],
			verificationRequirementIds: ["tests"],
		},
		{
			id: "test",
			title: "Add tests",
			description: "Cover the command lifecycle",
			dependsOn: ["implement"],
			fileIntents: [{ path: "test/commands.test.ts", action: "create", reason: "Add coverage" }],
			verificationRequirementIds: ["tests"],
		},
	],
	risks: [],
	verificationRequirements: [
		{
			id: "tests",
			kind: "test",
			description: "Focused command tests pass",
			required: true,
		},
	],
};

function evaluateModes(): readonly EvaluationResult[] {
	return MODE_CASES.map((evaluationCase) => {
		const advice = adviseExecutionMode({
			complexity: evaluationCase.complexity,
			riskLevel: evaluationCase.riskLevel,
			confidence: "high",
			reason: evaluationCase.task,
		});
		const selection = selectExecutionMode({ agentAdvice: advice });
		return {
			id: evaluationCase.id,
			passed: selection.mode === evaluationCase.expectedMode,
			detail: `expected ${evaluationCase.expectedMode}, selected ${selection.mode}`,
		};
	});
}

async function evaluatePlanLifecycle(): Promise<readonly EvaluationResult[]> {
	const workspace = mkdtempSync(join(tmpdir(), "pi-cli-agent-eval-"));
	try {
		const sessions = SessionManager.inMemory(workspace);
		const runtime = PlanWorkflowRuntime.start(sessions, {
			workflowId: "workflow-eval",
			rootTaskId: "task-root",
			planId: "plan-eval",
			request: {
				text: "Add a dependency-aware CLI command",
				cwd: workspace,
				attachments: [],
			},
		});
		runtime.submit(PLAN_CONTENT);
		const approvalPassed =
			runtime.workflow.status === "awaiting_approval" &&
			runtime.tasks.filter(({ kind }) => kind !== "control").length === 0;

		runtime.approve("Evaluation approval");
		const executableTasks = runtime.tasks.filter(({ kind }) => kind !== "control");
		const schedulingPassed =
			executableTasks.length === 2 &&
			executableTasks.filter(({ status }) => status === "ready").length === 1 &&
			executableTasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "test")?.status === "pending";

		await runtime.cancel("Evaluation recovery checkpoint");
		const recovered = PlanWorkflowRuntime.recoverLatest(sessions, {}, runtime.workflow.id);
		const recoveryPassed =
			recovered?.workflow.status === "cancelled" &&
			recovered.workflow.result?.reason === "Evaluation recovery checkpoint";

		return [
			{
				id: "approval-gate",
				passed: approvalPassed,
				detail: "Plan remained non-executable until explicit approval",
			},
			{
				id: "dependency-scheduling",
				passed: schedulingPassed,
				detail: "Only the dependency-free Task became ready",
			},
			{
				id: "snapshot-recovery",
				passed: recoveryPassed,
				detail: "Terminal state and stop reason recovered from persisted Workflow data",
			},
		];
	} finally {
		rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
}

const results = [...evaluateModes(), ...(await evaluatePlanLifecycle())];
const passed = results.filter((result) => result.passed).length;
const modeResults = results.filter((result) => MODE_CASES.some(({ id }) => id === result.id));

for (const result of results) {
	console.log(`[${result.passed ? "PASS" : "FAIL"}] ${result.id}: ${result.detail}`);
}
console.log(`Completion rate: ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`);
console.log(
	`Mode accuracy: ${modeResults.filter((result) => result.passed).length}/${modeResults.length} (${(
		(modeResults.filter((result) => result.passed).length / modeResults.length) * 100
	).toFixed(1)}%)`,
);

if (passed !== results.length) {
	process.exitCode = 1;
}
