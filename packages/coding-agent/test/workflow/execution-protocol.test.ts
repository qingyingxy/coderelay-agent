import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	applyExecutionProtocolToPlan,
	EXECUTION_PROTOCOL_VERSION,
	SessionExecutionProtocolRuntime,
	type WorkflowExecutionProtocol,
} from "../../src/core/workflow/index.ts";

const PROTOCOL: WorkflowExecutionProtocol = {
	version: EXECUTION_PROTOCOL_VERSION,
	name: "planner-worker-reviewer",
	requirements: [
		{
			id: "worker-implementation",
			stage: "implementation",
			role: "worker",
			required: true,
			minRuns: 1,
			maxRuns: 2,
			failurePolicy: "retry_once",
		},
		{
			id: "reviewer-before-delivery",
			stage: "before_delivery",
			role: "reviewer",
			required: true,
			minRuns: 1,
			maxRuns: 2,
			failurePolicy: "retry_once",
		},
	],
};

describe("Execution Protocol", () => {
	it("persists stage runs and recovers without duplicating a stable run", () => {
		const sessionManager = SessionManager.inMemory();
		const runtime = new SessionExecutionProtocolRuntime(sessionManager, "workflow-1", PROTOCOL);
		const run = runtime.begin("worker-implementation", "agent-worker", "stable-worker-run");
		runtime.succeed(run.id, {
			agentId: "agent-worker",
			handoffId: "handoff-worker",
			summary: "Implementation completed",
		});

		const recovered = new SessionExecutionProtocolRuntime(sessionManager, "workflow-1", PROTOCOL);
		const duplicate = recovered.begin("worker-implementation", "agent-worker", "stable-worker-run");

		expect(duplicate.status).toBe("succeeded");
		expect(recovered.view.runs).toHaveLength(1);
		expect(recovered.view.requirements.find(({ id }) => id === "worker-implementation")).toMatchObject({
			succeededRuns: 1,
			satisfied: true,
		});
		expect(() => recovered.assertStageSatisfied("before_delivery")).toThrow("reviewer-before-delivery");
	});

	it("compiles Worker and Reviewer gates into a model-produced Plan", () => {
		const compiled = applyExecutionProtocolToPlan(
			{
				goal: "Implement and verify the change",
				assumptions: [],
				steps: [
					{
						id: "inspect",
						kind: "agent",
						title: "Inspect",
						description: "Inspect the implementation",
						dependsOn: [],
						fileIntents: [{ path: "src/index.ts", action: "inspect", reason: "Find the change point" }],
						verificationRequirementIds: [],
					},
					{
						id: "test",
						kind: "command",
						command: "npm run test:unit",
						title: "Test",
						description: "Run unit tests",
						dependsOn: ["inspect"],
						fileIntents: [],
						verificationRequirementIds: ["test"],
					},
				],
				risks: [],
				verificationRequirements: [
					{
						id: "test",
						kind: "test",
						description: "Unit tests pass",
						required: true,
						command: "npm run test:unit",
					},
				],
			},
			PROTOCOL,
		);

		const worker = compiled.steps.find(({ requiredAgentRole }) => requiredAgentRole === "worker");
		expect(worker).toBeDefined();
		expect(compiled.steps.find(({ id }) => id === "test")?.dependsOn).toContain(worker?.id);
		expect(compiled.verificationRequirements).toContainEqual(
			expect.objectContaining({
				kind: "review",
				required: true,
			}),
		);
	});

	it("enforces the per-requirement run budget", () => {
		const runtime = new SessionExecutionProtocolRuntime(SessionManager.inMemory(), "workflow-budget", PROTOCOL);
		const first = runtime.begin("reviewer-before-delivery", undefined, "review-1");
		runtime.fail(first.id, "transport failed");
		const second = runtime.begin("reviewer-before-delivery", undefined, "review-2");
		runtime.fail(second.id, "review failed");

		expect(() => runtime.begin("reviewer-before-delivery", undefined, "review-3")).toThrow("exceeded maxRuns=2");
	});
});
