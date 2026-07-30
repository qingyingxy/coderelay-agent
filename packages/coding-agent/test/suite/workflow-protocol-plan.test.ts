import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EXECUTION_PROTOCOL_VERSION, type WorkflowExecutionProtocol } from "../../src/core/workflow/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const PLANNER_WORKER_REVIEWER_PROTOCOL: WorkflowExecutionProtocol = {
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

describe("Plan Execution Protocol integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("compiles missing Worker and Reviewer gates into a Planner response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("plan", false, PLANNER_WORKER_REVIEWER_PROTOCOL);
		harness.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					goal: "Implement the CLI change",
					assumptions: [],
					steps: [
						{
							id: "inspect",
							kind: "agent",
							title: "Inspect",
							description: "Inspect the current implementation",
							dependsOn: [],
							fileIntents: [
								{
									path: "src/index.ts",
									action: "inspect",
									reason: "Find the implementation boundary",
								},
							],
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
				}),
			),
		]);

		await harness.session.prompt("Implement the CLI change");

		const view = harness.session.getWorkflowView();
		const worker = view?.plan?.steps.find(({ requiredAgentRole }) => requiredAgentRole === "worker");
		expect(view?.workflow.status).toBe("awaiting_approval");
		expect(worker).toBeDefined();
		expect(view?.plan?.steps.find(({ id }) => id === "test")?.dependsOn).toContain(worker?.id);
		expect(view?.plan?.verificationRequirements).toContainEqual(
			expect.objectContaining({
				kind: "review",
				required: true,
			}),
		);
		expect(view?.executionProtocol).toMatchObject({
			name: "planner-worker-reviewer",
			satisfied: false,
		});
	});
});
