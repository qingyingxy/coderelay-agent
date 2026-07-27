import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type JobProcess,
	type JobProcessExit,
	type JobProcessFactory,
	JobRuntime,
	type PlanContent,
	type StartJobProcessInput,
	WorkflowRuntimeRegistry,
} from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

class PassingProcess implements JobProcess {
	readonly pid = 9200;
	readonly #input: StartJobProcessInput;

	constructor(input: StartJobProcessInput) {
		this.#input = input;
	}

	async wait(): Promise<JobProcessExit> {
		this.#input.onStdout("passed\n");
		return { exitCode: 0 };
	}

	async terminate(): Promise<void> {}
}

class PassingFactory implements JobProcessFactory {
	start(input: StartJobProcessInput): JobProcess {
		return new PassingProcess(input);
	}
}

function advisorResult(
	overrides: Partial<{
		complexity: "low" | "medium" | "high";
		riskLevel: "low" | "medium" | "high";
		confidence: "low" | "medium" | "high";
		reason: string;
		clarificationCandidates: readonly object[];
	}> = {},
): string {
	return JSON.stringify({
		complexity: "low",
		riskLevel: "low",
		confidence: "high",
		reason: "The request is narrow and low risk",
		clarificationCandidates: [],
		...overrides,
	});
}

function commandPlan(): PlanContent {
	return {
		goal: "Run the automated Workflow",
		assumptions: [],
		steps: [
			{
				id: "check",
				kind: "command",
				command: "check",
				title: "Run check",
				description: "Run the deterministic check",
				dependsOn: [],
				fileIntents: [],
				verificationRequirementIds: ["check"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "check",
				kind: "test",
				description: "Check passes",
				command: "check",
				required: true,
			},
		],
	};
}

describe("Autonomous Workflow AgentSession integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("uses Mode Advisor and completes a Direct Workflow", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("auto", true);
		harness.setResponses([fauxAssistantMessage(advisorResult()), fauxAssistantMessage("Current status explained.")]);

		await harness.session.prompt("Explain the current status");

		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: {
				status: "completed",
				modeDecision: { mode: "direct", source: "agent" },
			},
			automation: { enabled: true, mode: "auto" },
		});
		expect(harness.eventsOfType("workflow_mode_decided")).toEqual([
			expect.objectContaining({ decision: expect.objectContaining({ mode: "direct", source: "agent" }) }),
		]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("automatically dispatches and verifies an approved Plan", async () => {
		const jobRuntime = new JobRuntime({
			processFactory: new PassingFactory(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		const harness = await createHarness({ jobRuntime });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("auto", true);
		harness.setResponses([
			fauxAssistantMessage(
				advisorResult({
					complexity: "high",
					riskLevel: "medium",
					reason: "The request needs an approved multi-step Plan",
				}),
			),
			fauxAssistantMessage(JSON.stringify(commandPlan())),
		]);

		await harness.session.prompt("Implement a multi-step CLI change");
		expect(harness.session.getWorkflowView()?.workflow.status).toBe("awaiting_approval");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);

		await harness.session.prompt("/approve reviewed");
		await harness.session.waitForWorkflowAutomation();

		expect(harness.session.getWorkflowView()).toMatchObject({
			workflow: {
				status: "completed",
				modeDecision: { mode: "plan", source: "agent" },
			},
			tasks: expect.arrayContaining([expect.objectContaining({ kind: "command", status: "succeeded" })]),
		});
		expect(harness.eventsOfType("workflow_dispatch_started")).toHaveLength(1);
		expect(harness.eventsOfType("workflow_verification_started")).toHaveLength(1);
		expect(harness.eventsOfType("workflow_result")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("persists a required clarification and resumes from the user's answer", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("auto", true);
		harness.setResponses([
			fauxAssistantMessage(
				advisorResult({
					confidence: "low",
					reason: "The requested behavior is ambiguous",
					clarificationCandidates: [
						{
							id: "target",
							question: "Which behavior should be changed?",
							impact: "behavior",
							changesImplementation: true,
						},
					],
				}),
			),
			fauxAssistantMessage(advisorResult()),
			fauxAssistantMessage("Implemented the selected behavior."),
		]);

		await harness.session.prompt("Implement configurable behavior");
		expect(harness.session.getWorkflowView()).toBeUndefined();
		expect(harness.eventsOfType("workflow_waiting_for_user")).toEqual([
			expect.objectContaining({ kind: "clarification" }),
		]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "workflow-automation"),
		).toHaveLength(1);

		await harness.session.submitWorkflowClarification("Change the CLI output behavior");

		expect(harness.session.getWorkflowView()?.workflow).toMatchObject({
			status: "completed",
			request: { text: expect.stringContaining("Change the CLI output behavior") },
		});
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "workflow-automation"),
		).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(3);
	});
});
