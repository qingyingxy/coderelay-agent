import { BUILTIN_AGENT_PROFILES } from "./agent-profile.ts";
import {
	type ClarificationCandidate,
	type ClarificationGateResult,
	evaluateClarificationGate,
} from "./clarification-gate.ts";
import { adviseExecutionMode, type ModeAdvice } from "./mode-advisor.ts";
import {
	executePromptEnvelope,
	type PromptAgentSession,
	type PromptEnvelopeExecutionResult,
} from "./prompt-agent-session-adapter.ts";
import { createPromptEnvelope, type PromptEnvelope, type PromptTaskContext } from "./prompt-envelope.ts";
import type { IsoDateTime } from "./types.ts";

const MODE_ADVISOR_OUTPUT_SCHEMA = {
	type: "object",
	required: ["complexity", "riskLevel", "confidence", "reason", "clarificationCandidates"],
	properties: {
		complexity: { enum: ["low", "medium", "high"] },
		riskLevel: { enum: ["low", "medium", "high"] },
		confidence: { enum: ["low", "medium", "high"] },
		reason: { type: "string" },
		clarificationCandidates: { type: "array" },
	},
} as const;

export interface CreateModeAdvisorPromptInput {
	readonly createdAt: IsoDateTime;
	readonly requestText: string;
	readonly clarificationContext?: string;
}

export interface ModeAdvisorResult {
	readonly advice: ModeAdvice;
	readonly clarification: ClarificationGateResult;
	readonly candidates: readonly ClarificationCandidate[];
}

export class ModeAdvisorRuntimeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ModeAdvisorRuntimeError";
		this.code = code;
	}
}

export function createModeAdvisorPromptEnvelope(input: CreateModeAdvisorPromptInput): PromptEnvelope {
	const profile = BUILTIN_AGENT_PROFILES.mode_advisor;
	const task: PromptTaskContext = {
		id: "mode-advisor-task",
		workflowId: "workflow-preflight",
		title: "Select execution mode",
		description: "Assess the request before creating its authoritative Workflow",
		status: "pending",
		dependencyIds: [],
		verificationRequirements: [],
	};
	return createPromptEnvelope({
		promptVersion: "mode-advisor-v1",
		createdAt: input.createdAt,
		role: "mode_advisor",
		profileName: profile.name,
		task,
		context: [
			{
				id: "mode-advisor-profile",
				source: "agent_profile",
				content: profile.systemPrompt,
				required: true,
			},
			{
				id: "mode-advisor-request",
				source: "user_request",
				content: input.requestText,
				required: true,
			},
			...(input.clarificationContext
				? [
						{
							id: "mode-advisor-clarification",
							source: "handoff" as const,
							content: input.clarificationContext,
							required: true,
						},
					]
				: []),
			{
				id: "mode-advisor-task-context",
				source: "task",
				content: task.description,
				required: true,
			},
		],
		toolNames: [],
		constraints: [
			{
				id: "mode-advisor-no-execution",
				kind: "permission",
				description: "Do not use tools, execute the request, or modify the project.",
			},
			{
				id: "mode-advisor-conservative",
				kind: "safety",
				description:
					"Use Plan for high complexity, medium/high risk, destructive operations, releases, migrations, permission changes, or low confidence that changes implementation.",
			},
			{
				id: "mode-advisor-clarification",
				kind: "workflow",
				description:
					"Only propose a clarification when its answer materially changes implementation. Include a safeDefault when a conservative answer is available.",
			},
			{
				id: "mode-advisor-output",
				kind: "output",
				description:
					"Return only one JSON object. Each clarification candidate has id, question, impact, changesImplementation, and optional safeDefault {answer, reason}.",
			},
		],
		outputSchema: {
			id: "mode-advisor-result",
			version: "1",
			jsonSchema: MODE_ADVISOR_OUTPUT_SCHEMA,
		},
	});
}

export async function executeModeAdvisorPrompt(
	session: PromptAgentSession,
	envelope: PromptEnvelope,
): Promise<PromptEnvelopeExecutionResult> {
	if (envelope.role !== "mode_advisor" || envelope.toolNames.length > 0) {
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.invalid_envelope",
			"Mode Advisor execution requires the built-in tool-free Mode Advisor Profile",
		);
	}
	return executePromptEnvelope(session, envelope);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new ModeAdvisorRuntimeError("mode_advisor.output_invalid_shape", `${key} must be a non-empty string`);
	}
	return value;
}

function parseCandidate(value: unknown): ClarificationCandidate {
	if (!isRecord(value)) {
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_invalid_shape",
			"Clarification candidates must be objects",
		);
	}
	const impact = requiredString(value, "impact");
	if (!["scope", "behavior", "architecture", "safety", "verification", "preference"].includes(impact)) {
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_invalid_shape",
			`Unsupported clarification impact: ${impact}`,
		);
	}
	if (typeof value.changesImplementation !== "boolean") {
		throw new ModeAdvisorRuntimeError("mode_advisor.output_invalid_shape", "changesImplementation must be boolean");
	}
	let safeDefault: ClarificationCandidate["safeDefault"];
	if (value.safeDefault !== undefined) {
		if (!isRecord(value.safeDefault)) {
			throw new ModeAdvisorRuntimeError("mode_advisor.output_invalid_shape", "safeDefault must be an object");
		}
		safeDefault = {
			answer: requiredString(value.safeDefault, "answer"),
			reason: requiredString(value.safeDefault, "reason"),
		};
	}
	return {
		id: requiredString(value, "id"),
		question: requiredString(value, "question"),
		impact: impact as ClarificationCandidate["impact"],
		changesImplementation: value.changesImplementation,
		safeDefault,
	};
}

export function parseModeAdvisorResult(text: string): ModeAdvisorResult {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	const json = fenced ?? (start >= 0 && end > start ? text.slice(start, end + 1) : undefined);
	if (!json) {
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_not_json",
			"Mode Advisor response does not contain a JSON object",
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_invalid_json",
			error instanceof Error ? error.message : "Mode Advisor response contains invalid JSON",
		);
	}
	if (!isRecord(value) || !Array.isArray(value.clarificationCandidates)) {
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_invalid_shape",
			"Mode Advisor response does not match the required object shape",
		);
	}
	const candidates = value.clarificationCandidates.map(parseCandidate);
	const advice = adviseExecutionMode({
		complexity: requiredString(value, "complexity") as ModeAdvice["complexity"],
		riskLevel: requiredString(value, "riskLevel") as ModeAdvice["riskLevel"],
		confidence: requiredString(value, "confidence") as ModeAdvice["confidence"],
		reason: requiredString(value, "reason"),
	});
	return {
		advice,
		clarification: evaluateClarificationGate(candidates),
		candidates,
	};
}
