import { describe, expect, it } from "vitest";
import {
	createPromptEnvelope,
	isPromptContextSource,
	orderPromptContextEntries,
	PROMPT_CONTEXT_SOURCE_ORDER,
	type PromptContextEntry,
	validatePromptEnvelope,
} from "../../src/core/workflow/prompt-envelope.ts";
import { NOW } from "./fixtures.ts";

function entry(source: PromptContextEntry["source"], id: string = source): PromptContextEntry {
	return {
		id,
		source,
		content: `${source} content`,
		required: source === "agent_profile" || source === "user_request" || source === "task",
	};
}

describe("Prompt context ordering", () => {
	it("defines the canonical source order across model channels", () => {
		expect(PROMPT_CONTEXT_SOURCE_ORDER).toEqual([
			"agent_profile",
			"project_rule",
			"history",
			"user_request",
			"plan",
			"task",
			"handoff",
			"tool_schema",
		]);
	});

	it("orders mixed inputs deterministically and preserves order within a source", () => {
		const ordered = orderPromptContextEntries([
			entry("tool_schema"),
			entry("task"),
			entry("history", "history-1"),
			entry("agent_profile"),
			entry("history", "history-2"),
			entry("user_request"),
			entry("handoff"),
			entry("project_rule"),
			entry("plan"),
		]);

		expect(ordered.map(({ id }) => id)).toEqual([
			"agent_profile",
			"project_rule",
			"history-1",
			"history-2",
			"user_request",
			"plan",
			"task",
			"handoff",
			"tool_schema",
		]);
	});

	it("normalizes context order while creating an envelope", () => {
		const envelope = createPromptEnvelope({
			promptVersion: "worker-v1",
			createdAt: NOW,
			role: "worker",
			profileName: "worker",
			task: {
				id: "task-1",
				workflowId: "workflow-1",
				title: "Implement request",
				description: "Implement the current Task",
				status: "ready",
				dependencyIds: [],
				verificationRequirements: [],
			},
			context: [entry("task"), entry("agent_profile"), entry("user_request")],
			toolNames: ["read"],
			constraints: [
				{
					id: "scope",
					kind: "workflow",
					description: "Only execute the current Task",
				},
			],
			outputSchema: {
				id: "handoff",
				version: "1",
				jsonSchema: { type: "object" },
			},
		});

		expect(envelope.context.map(({ source }) => source)).toEqual(["agent_profile", "user_request", "task"]);
	});

	it("detects unsupported sources and non-canonical persisted order", () => {
		const envelope = createPromptEnvelope({
			promptVersion: "worker-v1",
			createdAt: NOW,
			role: "worker",
			profileName: "worker",
			task: {
				id: "task-1",
				workflowId: "workflow-1",
				title: "Implement request",
				description: "Implement the current Task",
				status: "ready",
				dependencyIds: [],
				verificationRequirements: [],
			},
			context: [entry("agent_profile"), entry("user_request"), entry("task")],
			toolNames: [],
			constraints: [{ id: "scope", kind: "workflow", description: "Stay in scope" }],
			outputSchema: { id: "handoff", version: "1", jsonSchema: { type: "object" } },
		});

		expect(
			validatePromptEnvelope({
				...envelope,
				context: [entry("task"), entry("user_request")],
			}).map(({ code }) => code),
		).toContain("prompt_envelope.context_order");
		expect(isPromptContextSource("unknown")).toBe(false);
		expect(
			validatePromptEnvelope({
				...envelope,
				context: [
					{
						...entry("task"),
						source: "unknown" as "task",
					},
				],
			}).map(({ code }) => code),
		).toContain("prompt_envelope.invalid_context_source");
	});
});
