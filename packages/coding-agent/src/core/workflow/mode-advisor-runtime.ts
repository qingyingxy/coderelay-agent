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

const CLARIFICATION_IMPACTS = [
	"scope",
	"behavior",
	"architecture",
	"safety",
	"verification",
	"preference",
] as const satisfies readonly ClarificationCandidate["impact"][];

export const MODE_ADVISOR_PROMPT_VERSION = "mode-advisor-v5";

const MODE_ADVISOR_OUTPUT_SCHEMA = {
	type: "object",
	required: ["complexity", "riskLevel", "confidence", "reason", "clarificationCandidates"],
	properties: {
		complexity: { enum: ["low", "medium", "high"] },
		riskLevel: { enum: ["low", "medium", "high"] },
		confidence: { enum: ["low", "medium", "high"] },
		reason: { type: "string", maxLength: 240 },
		clarificationCandidates: {
			type: "array",
			items: {
				type: "object",
				required: ["id", "question", "impact", "changesImplementation"],
				properties: {
					id: { type: "string" },
					question: { type: "string" },
					impact: { enum: CLARIFICATION_IMPACTS },
					changesImplementation: { type: "boolean" },
					safeDefault: {
						type: "object",
						required: ["answer", "reason"],
						properties: {
							answer: { type: "string" },
							reason: { type: "string" },
						},
					},
				},
			},
		},
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
		promptVersion: MODE_ADVISOR_PROMPT_VERSION,
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
					"Use Direct for bounded low-risk work that one coding Agent can inspect, implement, and verify, even when it spans a few closely related files. Use Plan for high complexity, medium/high operational risk, destructive operations, releases, migrations, permission changes, or low confidence that changes implementation. Do not raise risk solely because a localized implementation is subtle.",
			},
			{
				id: "mode-advisor-complexity-rubric",
				kind: "workflow",
				description:
					"Classify low complexity as a localized deterministic change. Classify medium as bounded work inside one component with focused verification, including local asynchronous state, Promise coalescing, TTL handling, or cache refresh. Classify high as cross-module or distributed concurrency, orchestration across multiple state owners, security boundaries, graph algorithms, migrations, or broad interacting invariants.",
			},
			{
				id: "mode-advisor-risk-rubric",
				kind: "safety",
				description:
					"Classify risk by blast radius and reversibility: low for isolated reversible changes with explicit verification; medium for persisted or user-visible behavior spanning components or requiring difficult rollback; high for destructive, security, permission, release, migration, or irreversible operations.",
			},
			{
				id: "mode-advisor-clarification",
				kind: "workflow",
				description:
					"Only propose a clarification when its answer materially changes the requested implementation. Treat omitted optional enhancements as out of scope instead of inventing requirements. Include a safeDefault when a conservative answer is available.",
			},
			{
				id: "mode-advisor-output",
				kind: "output",
				description: `Return only one compact JSON object with a reason of at most 240 characters and no extra prose. Each clarification candidate has id, question, impact (${CLARIFICATION_IMPACTS.join(" | ")}), changesImplementation, and optional safeDefault {answer, reason}.`,
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
	if (!CLARIFICATION_IMPACTS.some((candidate) => candidate === impact)) {
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

function parseCandidates(values: readonly unknown[]): readonly ClarificationCandidate[] {
	const candidates: ClarificationCandidate[] = [];
	for (const value of values) {
		try {
			candidates.push(parseCandidate(value));
		} catch (error) {
			if (!(error instanceof ModeAdvisorRuntimeError) || error.code !== "mode_advisor.output_invalid_shape") {
				throw error;
			}
		}
	}
	return candidates;
}

const TRUNCATED_DIRECT_ADVICE_PREFIX =
	/^\s*(?:```(?:json)?\s*)?\{\s*"complexity"\s*:\s*"low"\s*,\s*"riskLevel"\s*:\s*"low"\s*,\s*"confidence"\s*:\s*"high"\s*,\s*"reason"\s*:\s*"/i;

function recoverTruncatedDirectAdvice(text: string): ModeAdvisorResult | undefined {
	const trimmed = text.trim();
	if (trimmed.endsWith("}") || !TRUNCATED_DIRECT_ADVICE_PREFIX.test(trimmed)) return undefined;
	const advice = adviseExecutionMode({
		complexity: "low",
		riskLevel: "low",
		confidence: "high",
		reason: "Recovered the complete low-complexity, low-risk, high-confidence assessment from truncated output",
	});
	const candidates: readonly ClarificationCandidate[] = [];
	return {
		advice,
		clarification: evaluateClarificationGate(candidates),
		candidates,
	};
}

export function parseModeAdvisorResult(text: string): ModeAdvisorResult {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	const json = fenced ?? (start >= 0 && end > start ? text.slice(start, end + 1) : undefined);
	if (!json) {
		const recovered = recoverTruncatedDirectAdvice(text);
		if (recovered) return recovered;
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_not_json",
			"Mode Advisor response does not contain a JSON object",
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		const recovered = recoverTruncatedDirectAdvice(text);
		if (recovered) return recovered;
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_invalid_json",
			error instanceof Error ? error.message : "Mode Advisor response contains invalid JSON",
		);
	}
	if (!isRecord(value)) {
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_invalid_shape",
			"Mode Advisor response does not match the required object shape",
		);
	}
	if (value.clarificationCandidates !== undefined && !Array.isArray(value.clarificationCandidates)) {
		throw new ModeAdvisorRuntimeError(
			"mode_advisor.output_invalid_shape",
			"clarificationCandidates must be an array when present",
		);
	}
	const advice = adviseExecutionMode({
		complexity: requiredString(value, "complexity") as ModeAdvice["complexity"],
		riskLevel: requiredString(value, "riskLevel") as ModeAdvice["riskLevel"],
		confidence: requiredString(value, "confidence") as ModeAdvice["confidence"],
		reason: requiredString(value, "reason"),
	});
	const candidates = parseCandidates(value.clarificationCandidates ?? []);
	return {
		advice,
		clarification: evaluateClarificationGate(candidates),
		candidates,
	};
}
