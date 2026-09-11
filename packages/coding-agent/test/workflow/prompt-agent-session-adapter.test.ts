import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { PromptOptions } from "../../src/core/agent-session.ts";
import {
	executePromptEnvelope,
	type PromptAgentSession,
	PromptAgentSessionAdapterError,
	renderPromptEnvelope,
} from "../../src/core/workflow/prompt-agent-session-adapter.ts";
import { createPromptEnvelope, type PromptEnvelope } from "../../src/core/workflow/prompt-envelope.ts";
import { NOW } from "./fixtures.ts";

function createEnvelope(toolNames: readonly string[] = ["read"]): PromptEnvelope {
	return createPromptEnvelope({
		promptVersion: "worker-v1",
		createdAt: NOW,
		role: "worker",
		profileName: "worker",
		task: {
			id: "task-1",
			workflowId: "workflow-1",
			title: "Implement request",
			description: "Make the requested CLI change",
			status: "ready",
			dependencyIds: [],
			verificationRequirements: [],
		},
		context: [
			{
				id: "profile",
				source: "agent_profile",
				content: "PROFILE CONTENT IS SESSION MANAGED",
				required: true,
			},
			{
				id: "project-rule",
				source: "project_rule",
				content: "PROJECT RULE IS SESSION MANAGED",
				required: true,
			},
			{
				id: "history",
				source: "history",
				content: "HISTORY IS SESSION MANAGED",
				required: false,
			},
			{
				id: "request",
				source: "user_request",
				content: "Add a concise workflow status command",
				required: true,
			},
			{
				id: "plan",
				source: "plan",
				content: "Update the workflow presentation layer",
				required: false,
			},
			{
				id: "task",
				source: "task",
				content: "TASK CONTENT IS ALREADY STRUCTURED",
				required: true,
			},
			{
				id: "handoff",
				source: "handoff",
				content: "The status formatter is in report.ts",
				required: true,
			},
			{
				id: "tool-schema",
				source: "tool_schema",
				content: "TOOL SCHEMA IS SESSION MANAGED",
				required: false,
			},
		],
		toolNames,
		constraints: [
			{
				id: "task-scope",
				kind: "workflow",
				description: "Only implement the assigned Task",
			},
		],
		outputSchema: {
			id: "worker-handoff",
			version: "1",
			jsonSchema: {
				type: "object",
				required: ["summary"],
			},
		},
	});
}

class TestPromptAgentSession implements PromptAgentSession {
	isIdle = true;
	thinkingLevel: ThinkingLevel = "high";
	activeToolNames = ["read", "edit", "write"];
	readonly promptCalls: Array<{
		text: string;
		options: PromptOptions | undefined;
		activeToolNames: string[];
		thinkingLevel: ThinkingLevel;
	}> = [];
	readonly thinkingLevelCalls: ThinkingLevel[] = [];
	failPrompt = false;

	getActiveToolNames(): string[] {
		return [...this.activeToolNames];
	}

	setActiveToolsByName(toolNames: string[]): void {
		this.activeToolNames = [...toolNames];
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.thinkingLevel = level;
		this.thinkingLevelCalls.push(level);
	}

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		this.promptCalls.push({
			text,
			options,
			activeToolNames: [...this.activeToolNames],
			thinkingLevel: this.thinkingLevel,
		});
		if (this.failPrompt) {
			throw new Error("Prompt failed");
		}
	}
}

describe("PromptEnvelope AgentSession adapter", () => {
	it("renders workflow data without duplicating AgentSession-managed prompt sources", () => {
		const rendered = renderPromptEnvelope(createEnvelope());

		expect(rendered.text).toContain("Add a concise workflow status command");
		expect(rendered.text).toContain("Update the workflow presentation layer");
		expect(rendered.text).toContain("The status formatter is in report.ts");
		expect(rendered.text).toContain("Make the requested CLI change");
		expect(rendered.text).toContain("Only implement the assigned Task");
		expect(rendered.text).toContain('"id": "worker-handoff"');
		expect(rendered.text).not.toContain("PROFILE CONTENT IS SESSION MANAGED");
		expect(rendered.text).not.toContain("PROJECT RULE IS SESSION MANAGED");
		expect(rendered.text).not.toContain("HISTORY IS SESSION MANAGED");
		expect(rendered.text).not.toContain("TASK CONTENT IS ALREADY STRUCTURED");
		expect(rendered.text).not.toContain("TOOL SCHEMA IS SESSION MANAGED");
		expect(rendered.sessionManagedContextIds).toEqual(["profile", "project-rule", "history", "tool-schema"]);
		expect(rendered.structuredTaskContextIds).toEqual(["task"]);
		expect(rendered.renderedContextIds).toEqual(["request", "plan", "handoff"]);
	});

	it("temporarily narrows tools and disables nested workflow and template handling", async () => {
		const session = new TestPromptAgentSession();

		const result = await executePromptEnvelope(session, createEnvelope(["read"]));

		expect(session.promptCalls).toHaveLength(1);
		expect(session.promptCalls[0]).toMatchObject({
			options: {
				expandPromptTemplates: false,
				source: "extension",
			},
			activeToolNames: ["read"],
		});
		expect(session.activeToolNames).toEqual(["read", "edit", "write"]);
		expect(result).toMatchObject({
			promptVersion: "worker-v1",
			toolNames: ["read"],
		});
	});

	it("temporarily applies and restores the Profile thinking level", async () => {
		const session = new TestPromptAgentSession();
		const envelope: PromptEnvelope = {
			...createEnvelope([]),
			role: "mode_advisor",
			profileName: "mode-advisor",
		};

		await executePromptEnvelope(session, envelope);

		expect(session.promptCalls[0]?.thinkingLevel).toBe("off");
		expect(session.thinkingLevelCalls).toEqual(["off", "high"]);
		expect(session.thinkingLevel).toBe("high");
	});

	it("rejects tool escalation before changing the AgentSession", async () => {
		const session = new TestPromptAgentSession();

		await expect(executePromptEnvelope(session, createEnvelope(["bash"]))).rejects.toEqual(
			expect.objectContaining({
				code: "prompt_agent_session.tool_escalation",
				unavailableToolNames: ["bash"],
			}),
		);
		expect(session.activeToolNames).toEqual(["read", "edit", "write"]);
		expect(session.promptCalls).toHaveLength(0);
	});

	it("enforces the effective read-only Profile at the AgentSession boundary", async () => {
		const session = new TestPromptAgentSession();
		const envelope: PromptEnvelope = {
			...createEnvelope(["write"]),
			role: "reviewer",
			profileName: "reviewer",
		};

		await expect(executePromptEnvelope(session, envelope)).rejects.toEqual(
			expect.objectContaining({
				code: "prompt_agent_session.permission_denied",
				unavailableToolNames: ["write"],
			}),
		);
		expect(session.activeToolNames).toEqual(["read", "edit", "write"]);
		expect(session.promptCalls).toHaveLength(0);
	});

	it("restores the previous tool set when prompting fails", async () => {
		const session = new TestPromptAgentSession();
		session.failPrompt = true;

		await expect(executePromptEnvelope(session, createEnvelope(["read"]))).rejects.toThrow("Prompt failed");
		expect(session.activeToolNames).toEqual(["read", "edit", "write"]);
	});

	it("requires an idle AgentSession", async () => {
		const session = new TestPromptAgentSession();
		session.isIdle = false;

		await expect(executePromptEnvelope(session, createEnvelope())).rejects.toBeInstanceOf(
			PromptAgentSessionAdapterError,
		);
		expect(session.promptCalls).toHaveLength(0);
	});
});
