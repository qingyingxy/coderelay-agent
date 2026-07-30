import { describe, expect, it } from "vitest";
import {
	createPlannerPromptEnvelope,
	executePlannerPrompt,
	PlannerRuntimeError,
	parsePlannerPlanContent,
} from "../../src/core/workflow/index.ts";
import type { PromptAgentSession } from "../../src/core/workflow/prompt-agent-session-adapter.ts";
import { NOW } from "./fixtures.ts";

function envelope() {
	return createPlannerPromptEnvelope({
		createdAt: NOW,
		task: {
			id: "task-root",
			workflowId: "workflow-1",
			title: "Plan request",
			description: "Plan a CLI change",
			status: "pending",
			dependencyIds: [],
			verificationRequirements: [],
		},
		userRequest: "Plan a CLI change",
		activeToolNames: ["read", "grep", "bash", "edit", "write"],
	});
}

class FakePromptSession implements PromptAgentSession {
	isIdle = true;
	activeTools = ["read", "grep", "bash", "edit", "write"];
	promptTools: string[] = [];

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	setActiveToolsByName(toolNames: string[]): void {
		this.activeTools = [...toolNames];
	}

	async prompt(): Promise<void> {
		this.promptTools = [...this.activeTools];
	}
}

describe("Planner runtime", () => {
	it("constructs a Planner envelope with read-only tools only", () => {
		expect(envelope()).toMatchObject({
			role: "planner",
			profileName: "planner",
			toolNames: ["read", "grep"],
			outputSchema: {
				id: "plan-content",
				version: "1",
			},
		});
	});

	it("enforces the read-only tool boundary during execution and restores tools", async () => {
		const session = new FakePromptSession();

		await executePlannerPrompt(session, envelope());

		expect(session.promptTools).toEqual(["read", "grep"]);
		expect(session.activeTools).toEqual(["read", "grep", "bash", "edit", "write"]);
	});

	it("rejects a forged Planner envelope with a write tool", async () => {
		const session = new FakePromptSession();

		await expect(
			executePlannerPrompt(session, {
				...envelope(),
				toolNames: ["read", "write"],
			}),
		).rejects.toThrow(PlannerRuntimeError);
	});

	it("parses structured PlanContent and rejects prose-only output", () => {
		const content = parsePlannerPlanContent(`\`\`\`json
{
  "goal": "Implement Plan Mode",
  "assumptions": [],
  "steps": [],
  "risks": [],
  "verificationRequirements": []
}
\`\`\``);

		expect(content.goal).toBe("Implement Plan Mode");
		expect(() => parsePlannerPlanContent("I would inspect the repository first.")).toThrow(PlannerRuntimeError);
		expect(() =>
			parsePlannerPlanContent(
				JSON.stringify({
					goal: "Invalid nested content",
					assumptions: [],
					steps: [
						{
							id: "inspect",
							requiredAgentRole: "explorer",
							title: "Inspect",
							dependsOn: [],
							fileIntents: [],
							verificationRequirementIds: [],
						},
					],
					risks: [],
					verificationRequirements: [],
				}),
			),
		).toThrowError(
			expect.objectContaining({
				code: "planner.output_invalid_shape",
				message: "Planner response has an invalid steps[0].description",
			}),
		);
	});

	it("parses explicit Agent role requirements", () => {
		const content = parsePlannerPlanContent(
			JSON.stringify({
				goal: "Implement the change",
				assumptions: [],
				steps: [
					{
						id: "implement",
						kind: "agent",
						requiredAgentRole: "worker",
						title: "Implement",
						description: "Modify the implementation",
						dependsOn: [],
						fileIntents: [{ path: "src/index.ts", action: "modify", reason: "Implement the change" }],
						verificationRequirementIds: [],
					},
				],
				risks: [],
				verificationRequirements: [],
			}),
		);

		expect(content.steps[0]?.requiredAgentRole).toBe("worker");
	});
});
