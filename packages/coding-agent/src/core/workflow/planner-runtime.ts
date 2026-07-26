import { BUILTIN_AGENT_PROFILES } from "./agent-profile.ts";
import {
	executePromptEnvelope,
	type PromptAgentSession,
	type PromptEnvelopeExecutionResult,
} from "./prompt-agent-session-adapter.ts";
import { createPromptEnvelope, type PromptEnvelope, type PromptTaskContext } from "./prompt-envelope.ts";
import type { IsoDateTime, Plan, PlanContent } from "./types.ts";

const PLANNER_OUTPUT_SCHEMA = {
	type: "object",
	required: ["goal", "assumptions", "steps", "risks", "verificationRequirements"],
	properties: {
		goal: { type: "string" },
		assumptions: { type: "array" },
		steps: { type: "array" },
		risks: { type: "array" },
		verificationRequirements: { type: "array" },
	},
} as const;

export interface CreatePlannerPromptInput {
	readonly createdAt: IsoDateTime;
	readonly task: PromptTaskContext;
	readonly userRequest: string;
	readonly activeToolNames: readonly string[];
	readonly currentPlan?: Plan;
	readonly revisionRequest?: string;
}

export class PlannerRuntimeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PlannerRuntimeError";
		this.code = code;
	}
}

export function createPlannerPromptEnvelope(input: CreatePlannerPromptInput): PromptEnvelope {
	const profile = BUILTIN_AGENT_PROFILES.planner;
	const toolNames = profile.allowedTools.filter((toolName) => input.activeToolNames.includes(toolName));
	const context = [
		{
			id: "planner-profile",
			source: "agent_profile" as const,
			content: profile.systemPrompt,
			required: true,
		},
		{
			id: "planner-user-request",
			source: "user_request" as const,
			content: input.userRequest,
			required: true,
		},
		...(input.currentPlan
			? [
					{
						id: `planner-plan-${input.currentPlan.version}`,
						source: "plan" as const,
						content: JSON.stringify(input.currentPlan),
						required: true,
					},
				]
			: []),
		{
			id: "planner-task",
			source: "task" as const,
			content: input.task.description,
			required: true,
		},
		...(input.revisionRequest
			? [
					{
						id: "planner-revision-request",
						source: "handoff" as const,
						content: input.revisionRequest,
						required: true,
					},
				]
			: []),
	];
	return createPromptEnvelope({
		promptVersion: "planner-v1",
		createdAt: input.createdAt,
		role: "planner",
		profileName: profile.name,
		task: input.task,
		context,
		toolNames,
		constraints: [
			{
				id: "planner-read-only",
				kind: "permission",
				description: "Use only read, grep, find, and ls. Do not modify files or execute shell commands.",
			},
			{
				id: "planner-structured-output",
				kind: "output",
				description: "Return only one JSON object matching the requested PlanContent schema.",
			},
		],
		outputSchema: {
			id: "plan-content",
			version: "1",
			jsonSchema: PLANNER_OUTPUT_SCHEMA,
		},
	});
}

export function validatePlannerPromptEnvelope(envelope: PromptEnvelope): void {
	const profile = BUILTIN_AGENT_PROFILES.planner;
	if (envelope.role !== "planner" || envelope.profileName !== profile.name) {
		throw new PlannerRuntimeError(
			"planner.invalid_profile",
			"Planner execution requires the built-in Planner Profile",
		);
	}
	const forbiddenTools = envelope.toolNames.filter((toolName) => !profile.allowedTools.includes(toolName));
	if (forbiddenTools.length > 0) {
		throw new PlannerRuntimeError(
			"planner.tool_not_read_only",
			`Planner requested non-read-only tools: ${forbiddenTools.join(", ")}`,
		);
	}
	if (!envelope.constraints.some(({ id }) => id === "planner-read-only")) {
		throw new PlannerRuntimeError(
			"planner.read_only_constraint_required",
			"Planner read-only constraint is required",
		);
	}
}

export async function executePlannerPrompt(
	session: PromptAgentSession,
	envelope: PromptEnvelope,
): Promise<PromptEnvelopeExecutionResult> {
	validatePlannerPromptEnvelope(envelope);
	return executePromptEnvelope(session, envelope);
}

function extractJsonObject(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	if (fenced) {
		return fenced;
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new PlannerRuntimeError("planner.output_not_json", "Planner response does not contain a JSON object");
	}
	return text.slice(start, end + 1);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePlannerPlanContent(text: string): PlanContent {
	let value: unknown;
	try {
		value = JSON.parse(extractJsonObject(text));
	} catch (error) {
		if (error instanceof PlannerRuntimeError) {
			throw error;
		}
		throw new PlannerRuntimeError(
			"planner.output_invalid_json",
			error instanceof Error ? error.message : "Planner response contains invalid JSON",
		);
	}
	if (
		!isRecord(value) ||
		typeof value.goal !== "string" ||
		!Array.isArray(value.assumptions) ||
		!Array.isArray(value.steps) ||
		!Array.isArray(value.risks) ||
		!Array.isArray(value.verificationRequirements)
	) {
		throw new PlannerRuntimeError("planner.output_invalid_shape", "Planner response does not match PlanContent");
	}
	return structuredClone(value) as unknown as PlanContent;
}
