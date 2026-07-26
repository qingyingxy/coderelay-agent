import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionWorkflowEventLog } from "../../src/core/workflow/event-log.ts";
import { executePromptEnvelope } from "../../src/core/workflow/prompt-agent-session-adapter.ts";
import { createPromptEnvelope } from "../../src/core/workflow/prompt-envelope.ts";
import { createHarness, getUserTexts, type Harness } from "../suite/harness.ts";
import { NOW } from "./fixtures.ts";

describe("PromptEnvelope AgentSession integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reuses AgentSession history, system prompt, tool schema, and prompt lifecycle", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "edit", "write"],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Remembered"), fauxAssistantMessage("Completed")]);
		await harness.session.prompt("Earlier session context");
		harness.session.enableWorkflowTracking();

		let providerToolNames: string[] = [];
		let providerSystemPrompt = "";
		const streamFunction = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			providerToolNames = (context.tools ?? []).map(({ name }) => name);
			providerSystemPrompt = context.systemPrompt ?? "";
			return streamFunction(model, context, options);
		};

		const envelope = createPromptEnvelope({
			promptVersion: "worker-v1",
			createdAt: NOW,
			role: "worker",
			profileName: "worker",
			task: {
				id: "task-1",
				workflowId: "workflow-1",
				title: "Inspect status",
				description: "Read the status implementation",
				status: "ready",
				dependencyIds: [],
				verificationRequirements: [],
			},
			context: [
				{
					id: "profile",
					source: "agent_profile",
					content: "PROFILE MUST NOT BE DUPLICATED",
					required: true,
				},
				{
					id: "request",
					source: "user_request",
					content: "Inspect the workflow status implementation",
					required: true,
				},
				{
					id: "task",
					source: "task",
					content: "TASK MUST NOT BE DUPLICATED",
					required: true,
				},
				{
					id: "tool-schema",
					source: "tool_schema",
					content: "TOOL SCHEMA MUST NOT BE DUPLICATED",
					required: false,
				},
			],
			toolNames: ["read"],
			constraints: [
				{
					id: "read-only",
					kind: "permission",
					description: "Do not modify files",
				},
			],
			outputSchema: {
				id: "worker-handoff",
				version: "1",
				jsonSchema: { type: "object" },
			},
		});

		await executePromptEnvelope(harness.session, envelope);

		const userTexts = getUserTexts(harness);
		const promptText = userTexts.at(-1);
		expect(userTexts[0]).toBe("Earlier session context");
		expect(promptText).toContain("Inspect the workflow status implementation");
		expect(promptText).not.toContain("PROFILE MUST NOT BE DUPLICATED");
		expect(promptText).not.toContain("TASK MUST NOT BE DUPLICATED");
		expect(promptText).not.toContain("TOOL SCHEMA MUST NOT BE DUPLICATED");
		expect(providerToolNames).toEqual(["read"]);
		expect(providerSystemPrompt).toContain("- read:");
		expect(providerSystemPrompt).not.toContain("- edit:");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write"]);
		expect(harness.session.systemPrompt).toContain("- edit:");
		expect(new SessionWorkflowEventLog(harness.sessionManager).read()).toHaveLength(0);
	});
});
