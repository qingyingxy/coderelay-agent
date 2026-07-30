import { BUILTIN_AGENT_PROFILES } from "./agent-profile.ts";
import {
	executePromptEnvelope,
	type PromptAgentSession,
	type PromptEnvelopeExecutionResult,
} from "./prompt-agent-session-adapter.ts";
import { createPromptEnvelope, type PromptEnvelope, type PromptTaskContext } from "./prompt-envelope.ts";
import {
	FILE_INTENT_ACTIONS,
	type FileIntentAction,
	type IsoDateTime,
	type Plan,
	type PlanContent,
	type PlanRisk,
	type PlanStep,
	type VerificationKind,
	type VerificationRequirement,
} from "./types.ts";

const PLANNER_OUTPUT_SCHEMA = {
	type: "object",
	required: ["goal", "assumptions", "steps", "risks", "verificationRequirements"],
	properties: {
		goal: { type: "string" },
		assumptions: { type: "array", items: { type: "string" } },
		steps: {
			type: "array",
			items: {
				type: "object",
				required: ["id", "title", "description", "dependsOn", "fileIntents", "verificationRequirementIds"],
				properties: {
					id: { type: "string" },
					kind: { type: "string", enum: ["agent", "command"] },
					command: { type: "string" },
					requiredAgentRole: { type: "string", enum: ["explorer", "worker", "reviewer"] },
					title: { type: "string" },
					description: { type: "string" },
					dependsOn: { type: "array", items: { type: "string" } },
					fileIntents: {
						type: "array",
						items: {
							type: "object",
							required: ["path", "action", "reason"],
							properties: {
								path: { type: "string" },
								action: { type: "string", enum: FILE_INTENT_ACTIONS },
								reason: { type: "string" },
							},
						},
					},
					verificationRequirementIds: { type: "array", items: { type: "string" } },
				},
			},
		},
		risks: {
			type: "array",
			items: {
				type: "object",
				required: ["level", "description", "mitigation"],
				properties: {
					level: { type: "string", enum: ["low", "medium", "high"] },
					description: { type: "string" },
					mitigation: { type: "string" },
				},
			},
		},
		verificationRequirements: {
			type: "array",
			items: {
				type: "object",
				required: ["id", "kind", "description", "required"],
				properties: {
					id: { type: "string" },
					kind: { type: "string", enum: ["diff", "review", "test", "build", "manual"] },
					description: { type: "string" },
					required: { type: "boolean" },
					command: { type: "string" },
				},
			},
		},
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
				description:
					"Return only one JSON object matching PlanContent. Agent steps must declare requiredAgentRole: use worker for implementation, explorer for read-only investigation, and reviewer only for read-only review. Use step kind 'command' with a non-empty command for deterministic test/build commands and omit requiredAgentRole.",
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

function invalidShape(path: string): never {
	throw new PlannerRuntimeError("planner.output_invalid_shape", `Planner response has an invalid ${path}`);
}

function nonEmptyString(value: unknown, path: string): string {
	return typeof value === "string" && value.trim() ? value : invalidShape(path);
}

function stringArray(value: unknown, path: string): readonly string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
		return invalidShape(path);
	}
	return [...value];
}

function parsePlanStep(value: unknown, index: number): PlanStep {
	const path = `steps[${index}]`;
	if (!isRecord(value)) return invalidShape(path);
	const kind = value.kind;
	if (kind !== undefined && kind !== "agent" && kind !== "command") {
		return invalidShape(`${path}.kind`);
	}
	const command = value.command;
	if (command !== undefined && (typeof command !== "string" || !command.trim())) {
		return invalidShape(`${path}.command`);
	}
	const requiredAgentRole = value.requiredAgentRole;
	if (
		requiredAgentRole !== undefined &&
		requiredAgentRole !== "explorer" &&
		requiredAgentRole !== "worker" &&
		requiredAgentRole !== "reviewer"
	) {
		return invalidShape(`${path}.requiredAgentRole`);
	}
	if (!Array.isArray(value.fileIntents)) return invalidShape(`${path}.fileIntents`);
	const fileIntents = value.fileIntents.map((intent, intentIndex) => {
		const intentPath = `${path}.fileIntents[${intentIndex}]`;
		if (!isRecord(intent)) return invalidShape(intentPath);
		const action = intent.action;
		if (typeof action !== "string" || !FILE_INTENT_ACTIONS.includes(action as FileIntentAction)) {
			return invalidShape(`${intentPath}.action`);
		}
		return {
			path: nonEmptyString(intent.path, `${intentPath}.path`),
			action: action as FileIntentAction,
			reason: nonEmptyString(intent.reason, `${intentPath}.reason`),
		};
	});
	return {
		id: nonEmptyString(value.id, `${path}.id`),
		kind,
		command,
		requiredAgentRole,
		title: nonEmptyString(value.title, `${path}.title`),
		description: nonEmptyString(value.description, `${path}.description`),
		dependsOn: stringArray(value.dependsOn, `${path}.dependsOn`),
		fileIntents,
		verificationRequirementIds: stringArray(value.verificationRequirementIds, `${path}.verificationRequirementIds`),
	};
}

function parsePlanRisk(value: unknown, index: number): PlanRisk {
	const path = `risks[${index}]`;
	if (!isRecord(value)) return invalidShape(path);
	if (value.level !== "low" && value.level !== "medium" && value.level !== "high") {
		return invalidShape(`${path}.level`);
	}
	return {
		level: value.level,
		description: nonEmptyString(value.description, `${path}.description`),
		mitigation: nonEmptyString(value.mitigation, `${path}.mitigation`),
	};
}

const VERIFICATION_KINDS: readonly VerificationKind[] = ["diff", "review", "test", "build", "manual"];

function parseVerificationRequirement(value: unknown, index: number): VerificationRequirement {
	const path = `verificationRequirements[${index}]`;
	if (!isRecord(value)) return invalidShape(path);
	const kind = value.kind;
	if (typeof kind !== "string" || !VERIFICATION_KINDS.includes(kind as VerificationKind)) {
		return invalidShape(`${path}.kind`);
	}
	if (typeof value.required !== "boolean") return invalidShape(`${path}.required`);
	const command = value.command;
	if (command !== undefined && (typeof command !== "string" || !command.trim())) {
		return invalidShape(`${path}.command`);
	}
	return {
		id: nonEmptyString(value.id, `${path}.id`),
		kind: kind as VerificationKind,
		description: nonEmptyString(value.description, `${path}.description`),
		required: value.required,
		command,
	};
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
	if (
		value.assumptions.some((assumption) => typeof assumption !== "string" || !assumption.trim()) ||
		value.steps.some((step) => !isRecord(step)) ||
		value.risks.some((risk) => !isRecord(risk)) ||
		value.verificationRequirements.some((requirement) => !isRecord(requirement))
	) {
		throw new PlannerRuntimeError("planner.output_invalid_shape", "Planner response does not match PlanContent");
	}
	return {
		goal: nonEmptyString(value.goal, "goal"),
		assumptions: stringArray(value.assumptions, "assumptions"),
		steps: value.steps.map(parsePlanStep),
		risks: value.risks.map(parsePlanRisk),
		verificationRequirements: value.verificationRequirements.map(parseVerificationRequirement),
	};
}
