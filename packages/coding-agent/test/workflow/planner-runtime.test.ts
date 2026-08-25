import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	createPlannerPromptEnvelope,
	executePlannerPrompt,
	PlannerRuntimeError,
	PlanWorkflowRuntime,
	parsePlannerPlanContent,
	parsePlannerPlanContentWithRepair,
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
		allowedVerificationCommands: ["node verify.js"],
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

	async prompt(_text?: string): Promise<void> {
		this.promptTools = [...this.activeTools];
	}
}

class RepairPromptSession extends FakePromptSession {
	readonly promptCalls: Array<{ text: string; activeTools: string[] }> = [];
	repairedText: string | undefined;

	override async prompt(text = ""): Promise<void> {
		this.promptCalls.push({ text, activeTools: [...this.activeTools] });
	}

	getLastAssistantText(): string | undefined {
		return this.repairedText;
	}
}

describe("Planner runtime", () => {
	it("constructs a Planner envelope with read-only tools only", () => {
		const prompt = envelope();
		expect(prompt).toMatchObject({
			role: "planner",
			profileName: "planner",
			toolNames: ["read", "grep"],
			outputSchema: {
				id: "plan-content",
				version: "1",
			},
		});
		expect(prompt.constraints).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "planner-command-success",
					description: expect.stringContaining("must be expected to exit successfully"),
				}),
				expect.objectContaining({
					id: "planner-worker-decomposition",
					description: expect.stringContaining("do not split by file alone"),
				}),
				expect.objectContaining({
					id: "planner-verification-efficiency",
					description: expect.stringMatching(
						/never invent additional verification commands.*node verify\.js.*Do not create a Reviewer Agent step/s,
					),
				}),
			]),
		);
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

	it("rejects a Planner envelope without the command success constraint", async () => {
		const session = new FakePromptSession();
		const prompt = envelope();

		await expect(
			executePlannerPrompt(session, {
				...prompt,
				constraints: prompt.constraints.filter(({ id }) => id !== "planner-command-success"),
			}),
		).rejects.toMatchObject({ code: "planner.command_success_constraint_required" });
	});

	it("rejects a Planner envelope without the Worker decomposition constraint", async () => {
		const session = new FakePromptSession();
		const prompt = envelope();

		await expect(
			executePlannerPrompt(session, {
				...prompt,
				constraints: prompt.constraints.filter(({ id }) => id !== "planner-worker-decomposition"),
			}),
		).rejects.toMatchObject({ code: "planner.worker_decomposition_constraint_required" });
	});

	it("rejects a Planner envelope without the verification efficiency constraint", async () => {
		const session = new FakePromptSession();
		const prompt = envelope();

		await expect(
			executePlannerPrompt(session, {
				...prompt,
				constraints: prompt.constraints.filter(({ id }) => id !== "planner-verification-efficiency"),
			}),
		).rejects.toMatchObject({ code: "planner.verification_efficiency_constraint_required" });
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

	it("repairs invalid PlanContent once with all tools disabled", async () => {
		const session = new RepairPromptSession();
		session.repairedText = JSON.stringify({
			goal: "Implement Plan Mode",
			assumptions: [],
			steps: [],
			risks: [],
			verificationRequirements: [],
		});

		const content = await parsePlannerPlanContentWithRepair(session, "not json");

		expect(content.goal).toBe("Implement Plan Mode");
		expect(session.promptCalls).toEqual([
			expect.objectContaining({
				text: expect.stringContaining("Planner response does not contain a JSON object"),
				activeTools: [],
			}),
		]);
		expect(session.activeTools).toEqual(["read", "grep", "bash", "edit", "write"]);
	});

	it("fails after one invalid PlanContent repair", async () => {
		const session = new RepairPromptSession();
		session.repairedText = "still not json";

		await expect(parsePlannerPlanContentWithRepair(session, "not json")).rejects.toMatchObject({
			code: "planner.output_not_json",
		});
		expect(session.promptCalls).toHaveLength(1);
	});

	it("prefers an explicit JSON fence after an earlier source-code fence", () => {
		const content = parsePlannerPlanContent(
			`Analysis:\n\n\`\`\`js\nvalue.trim().replace(/\\s+/g, "-");\n\`\`\`\n\nPlan:\n\n\`\`\`json\n{\n  "goal": "Repair slug normalization",\n  "assumptions": [],\n  "steps": [],\n  "risks": [],\n  "verificationRequirements": []\n}\n\`\`\``,
		);

		expect(content.goal).toBe("Repair slug normalization");
	});

	it("repairs regex escapes and ignores text after the first complete JSON object", () => {
		const valid = JSON.stringify({
			goal: "Repair slug normalization",
			assumptions: [],
			steps: [
				{
					id: "implement",
					kind: "agent",
					requiredAgentRole: "worker",
					title: "Implement",
					description: String.raw`Replace whitespace with \s+`,
					dependsOn: [],
					fileIntents: [],
					verificationRequirementIds: [],
				},
			],
			risks: [],
			verificationRequirements: [],
		});
		const malformed = valid.replace(String.raw`\\s+`, String.raw`\s+`);

		const content = parsePlannerPlanContent(`\`\`\`json\n${malformed}\nTrailing explanation {ignored}.\n\`\`\``);

		expect(content.steps[0]?.description).toBe(String.raw`Replace whitespace with \s+`);
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

	it("rejects explicit Reviewer steps because Delivery owns the single review", () => {
		const response = JSON.stringify({
			goal: "Implement and review",
			assumptions: [],
			steps: [
				{
					id: "review",
					kind: "agent",
					requiredAgentRole: "reviewer",
					title: "Review",
					description: "Review the implementation",
					dependsOn: [],
					fileIntents: [],
					verificationRequirementIds: ["review-result"],
				},
			],
			risks: [],
			verificationRequirements: [
				{
					id: "review-result",
					kind: "review",
					description: "Delivery review passes",
					required: true,
				},
			],
		});

		expect(() => parsePlannerPlanContent(response)).toThrowError(
			expect.objectContaining({ code: "planner.reviewer_step_not_allowed" }),
		);
	});

	it("rejects command steps that were not configured for the Workflow", () => {
		const response = JSON.stringify({
			goal: "Repair and verify",
			assumptions: [],
			steps: [
				{
					id: "verify",
					kind: "command",
					command: "npx mocha test/extra.test.js",
					title: "Verify",
					description: "Run an invented check",
					dependsOn: [],
					fileIntents: [],
					verificationRequirementIds: ["tests"],
				},
			],
			risks: [],
			verificationRequirements: [
				{
					id: "tests",
					kind: "test",
					description: "Tests pass",
					required: true,
					command: "npx mocha test/extra.test.js",
				},
			],
		});

		expect(() => parsePlannerPlanContent(response, ["node verify.js"])).toThrowError(
			expect.objectContaining({ code: "planner.command_not_configured" }),
		);
	});

	it("removes explanatory text accidentally emitted as a requirement command", () => {
		const content = parsePlannerPlanContent(
			JSON.stringify({
				goal: "Repair and verify",
				assumptions: [],
				steps: [
					{
						id: "implement",
						kind: "agent",
						requiredAgentRole: "worker",
						title: "Implement",
						description: "Implement the repair",
						dependsOn: [],
						fileIntents: [],
						verificationRequirementIds: ["behavior"],
					},
					{
						id: "verify",
						kind: "command",
						command: "node verify.js",
						title: "Verify",
						description: "Run verification",
						dependsOn: ["implement"],
						fileIntents: [],
						verificationRequirementIds: ["tests"],
					},
				],
				risks: [],
				verificationRequirements: [
					{
						id: "behavior",
						kind: "test",
						description: "Behavior is correct",
						required: true,
						command: "Implicitly validated by the verify step",
					},
					{
						id: "tests",
						kind: "test",
						description: "Tests pass",
						required: true,
						command: "node verify.js",
					},
				],
			}),
			["node verify.js"],
		);

		expect(content.verificationRequirements[0]).toMatchObject({ id: "behavior" });
		expect(content.verificationRequirements[0]).not.toHaveProperty("command");
		expect(content.verificationRequirements[1]).toMatchObject({ id: "tests", command: "node verify.js" });
	});

	it("binds an unverified command step to a matching required verification", () => {
		const runtime = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
			workflowId: "workflow-command-verification",
			rootTaskId: "root-command-verification",
			planId: "plan-command-verification",
			request: { text: "Repair and verify", cwd: process.cwd(), attachments: [] },
		});
		runtime.submit({
			goal: "Repair and verify",
			assumptions: [],
			steps: [
				{
					id: "verify",
					kind: "command",
					command: "node verify.js",
					title: "Verify the repair",
					description: "Run the deterministic verifier",
					dependsOn: [],
					fileIntents: [],
					verificationRequirementIds: [],
				},
			],
			risks: [],
			verificationRequirements: [
				{
					id: "deterministic-verification",
					kind: "test",
					description: "The deterministic verifier passes",
					required: true,
					command: "node verify.js",
				},
			],
		});
		runtime.approve();

		expect(runtime.currentPlan.steps[0]?.verificationRequirementIds).toEqual(["deterministic-verification"]);
		expect(runtime.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "verify")).toMatchObject({
			kind: "command",
			command: "node verify.js",
			verificationRequirements: [expect.objectContaining({ id: "deterministic-verification", required: true })],
		});
	});

	it("creates a required verification when an unverified command has no matching requirement", () => {
		const runtime = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
			workflowId: "workflow-generated-command-verification",
			rootTaskId: "root-generated-command-verification",
			planId: "plan-generated-command-verification",
			request: { text: "Run verification", cwd: process.cwd(), attachments: [] },
		});
		runtime.submit({
			goal: "Run verification",
			assumptions: [],
			steps: [
				{
					id: "verify",
					kind: "command",
					command: "node verify.js",
					title: "Verify",
					description: "Run verification",
					dependsOn: [],
					fileIntents: [],
					verificationRequirementIds: [],
				},
			],
			risks: [],
			verificationRequirements: [],
		});

		expect(runtime.currentPlan).toMatchObject({
			steps: [expect.objectContaining({ verificationRequirementIds: ["command-verification-1"] })],
			verificationRequirements: [
				expect.objectContaining({
					id: "command-verification-1",
					command: "node verify.js",
					required: true,
				}),
			],
		});
	});
});
