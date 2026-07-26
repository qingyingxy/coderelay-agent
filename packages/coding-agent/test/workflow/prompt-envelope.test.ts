import { describe, expect, it } from "vitest";
import type { CreatePromptEnvelopeInput, PromptEnvelope } from "../../src/core/workflow/prompt-envelope.ts";
import {
	createPromptEnvelope,
	PROMPT_ENVELOPE_SCHEMA_VERSION,
	PromptEnvelopeError,
	validatePromptEnvelope,
} from "../../src/core/workflow/prompt-envelope.ts";
import { NOW } from "./fixtures.ts";

function createInput(): CreatePromptEnvelopeInput {
	return {
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
				content: "Execute only the assigned Worker Task",
				required: true,
			},
			{
				id: "request",
				source: "user_request",
				content: "Add a concise workflow status command",
				required: true,
			},
			{
				id: "task",
				source: "task",
				content: "Implement request: Make the requested CLI change",
				required: true,
			},
		],
		toolNames: ["read", "edit", "write"],
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
	};
}

describe("PromptEnvelope", () => {
	it("creates a complete, versioned envelope", () => {
		const envelope = createPromptEnvelope(createInput());

		expect(envelope).toMatchObject({
			schemaVersion: PROMPT_ENVELOPE_SCHEMA_VERSION,
			promptVersion: "worker-v1",
			role: "worker",
			profileName: "worker",
			task: {
				id: "task-1",
				workflowId: "workflow-1",
			},
			toolNames: ["read", "edit", "write"],
			outputSchema: {
				id: "worker-handoff",
				version: "1",
			},
		});
		expect(validatePromptEnvelope(envelope)).toEqual([]);
	});

	it("supports a tool-free ModeAdvisor envelope", () => {
		const envelope = createPromptEnvelope({
			...createInput(),
			promptVersion: "mode-advisor-v1",
			role: "mode_advisor",
			profileName: "mode-advisor",
			toolNames: [],
			outputSchema: {
				id: "mode-advice",
				version: "1",
				jsonSchema: { type: "object" },
			},
		});

		expect(envelope.toolNames).toEqual([]);
	});

	it("clones caller-owned context and schema data", () => {
		const input = createInput();
		const envelope = createPromptEnvelope(input);
		(input.context as unknown as Array<{ content: string }>)[1]!.content = "Mutated";
		(input.outputSchema.jsonSchema as Record<string, unknown>).type = "string";

		expect(envelope.context[1]?.content).toBe("Add a concise workflow status command");
		expect(envelope.outputSchema.jsonSchema.type).toBe("object");
	});

	it("rejects missing context, constraints, and malformed output schemas", () => {
		expect(() =>
			createPromptEnvelope({
				...createInput(),
				context: [],
				constraints: [],
				outputSchema: {
					id: "worker-handoff",
					version: "1",
					jsonSchema: [] as unknown as Record<string, unknown>,
				},
			}),
		).toThrowError(
			expect.objectContaining({
				violations: expect.arrayContaining([
					expect.objectContaining({ code: "prompt_envelope.context_required" }),
					expect.objectContaining({ code: "prompt_envelope.constraints_required" }),
					expect.objectContaining({ code: "prompt_envelope.invalid_output_schema" }),
				]),
			}),
		);
	});

	it("rejects duplicate context, tools, and constraints", () => {
		const input = createInput();
		expect(() =>
			createPromptEnvelope({
				...input,
				context: [input.context[0]!, input.context[0]!],
				toolNames: ["read", "read"],
				constraints: [input.constraints[0]!, input.constraints[0]!],
			}),
		).toThrow(PromptEnvelopeError);
	});

	it("detects unsupported persisted schema versions", () => {
		const envelope: PromptEnvelope = {
			...createPromptEnvelope(createInput()),
			schemaVersion: 99,
		};

		expect(validatePromptEnvelope(envelope)).toContainEqual(
			expect.objectContaining({ code: "prompt_envelope.unsupported_schema" }),
		);
	});
});
