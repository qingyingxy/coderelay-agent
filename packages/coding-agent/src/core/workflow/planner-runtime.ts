import { BUILTIN_AGENT_PROFILES } from "./agent-profile.ts";
import {
	executePromptEnvelope,
	type PromptAgentSession,
	type PromptEnvelopeExecutionResult,
} from "./prompt-agent-session-adapter.ts";
import { createPromptEnvelope, type PromptEnvelope, type PromptTaskContext } from "./prompt-envelope.ts";
import {
	type BudgetLimit,
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

export type PlannerPhase = "investigating" | "finalizing" | "repairing_json";

const PLANNER_INVESTIGATION_TIMEOUT_MS = 90_000;
const PLANNER_FINALIZE_INSTRUCTION = [
	"The single investigation round is complete. Stop repository exploration now.",
	"Use the evidence already collected and return only the complete PlanContent JSON object required by the envelope.",
	"Do not call another tool.",
].join(" ");

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
	readonly allowedVerificationCommands?: readonly string[];
}

export interface ExecutePlannerPromptOptions {
	readonly budget?: BudgetLimit;
	readonly investigationTimeoutMs?: number;
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
		promptVersion: "planner-v2",
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
				id: "planner-command-success",
				kind: "workflow",
				description:
					"Every command step is a completion gate and must be expected to exit successfully. Never create a command step for a baseline check that is expected to fail; assign diagnosis to an explorer or worker Agent instead.",
			},
			{
				id: "planner-worker-decomposition",
				kind: "workflow",
				description:
					"Minimize handoffs while keeping Worker Tasks coherent. Keep strongly coupled changes for one behavior in one Worker even when they span several files; do not split by file alone. Split only independent outcomes that can be implemented or verified separately, and prefer one Worker for bounded defect repairs. Give every Worker an explicit file boundary, outcome, dependencies, and verification intent.",
			},
			{
				id: "planner-bounded-investigation",
				kind: "budget",
				description:
					"Use at most one investigation round. If repository context is needed, issue every necessary read, grep, find, or ls call together in the first response so they can run in parallel. After those results, the tool boundary closes and the next response must be the complete PlanContent JSON. If the request already contains enough information, return PlanContent immediately without tools.",
			},
			{
				id: "planner-verification-efficiency",
				kind: "workflow",
				description: `Use only deterministic verification commands explicitly supplied by the user or Task as command gates; never invent additional verification commands. ${
					input.allowedVerificationCommands?.length
						? `The configured commands are exactly: ${input.allowedVerificationCommands.join("; ")}.`
						: ""
				} Do not create additional Worker Tasks solely to run verification, and do not ask Workers to create temporary verification scripts or other repository artifacts. Do not create a Reviewer Agent step; the Delivery Runtime owns the single read-only review stage. Express review needs as review verification requirements instead.`,
			},
			{
				id: "planner-structured-output",
				kind: "output",
				description:
					"Return only one JSON object matching PlanContent. Agent steps must declare requiredAgentRole: use worker for implementation and explorer for read-only investigation. The Delivery Runtime owns review, so never create a reviewer Agent step. Use step kind 'command' with a non-empty command for deterministic test/build commands and omit requiredAgentRole.",
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
	if (!envelope.constraints.some(({ id }) => id === "planner-command-success")) {
		throw new PlannerRuntimeError(
			"planner.command_success_constraint_required",
			"Planner command success constraint is required",
		);
	}
	if (!envelope.constraints.some(({ id }) => id === "planner-worker-decomposition")) {
		throw new PlannerRuntimeError(
			"planner.worker_decomposition_constraint_required",
			"Planner Worker decomposition constraint is required",
		);
	}
	if (!envelope.constraints.some(({ id }) => id === "planner-verification-efficiency")) {
		throw new PlannerRuntimeError(
			"planner.verification_efficiency_constraint_required",
			"Planner verification efficiency constraint is required",
		);
	}
}

export async function executePlannerPrompt(
	session: PromptAgentSession,
	envelope: PromptEnvelope,
	options: ExecutePlannerPromptOptions = {},
): Promise<PromptEnvelopeExecutionResult> {
	validatePlannerPromptEnvelope(envelope);
	const budget = options.budget ?? BUILTIN_AGENT_PROFILES.planner.defaultBudget;
	const maxTurns = budget.maxTurns;
	const maxDurationMs = budget.maxDurationMs;
	const investigationTimeoutMs = Math.min(
		options.investigationTimeoutMs ?? PLANNER_INVESTIGATION_TIMEOUT_MS,
		maxDurationMs ?? Number.POSITIVE_INFINITY,
	);
	let phase: PlannerPhase = "investigating";
	let assistantTurns = 0;
	let investigationUsedTools = false;
	let budgetFailure: PlannerRuntimeError | undefined;
	let durationTimeout: ReturnType<typeof setTimeout> | undefined;
	let investigationTimeout: ReturnType<typeof setTimeout> | undefined;

	const requestFinalOutput = (): void => {
		if (phase !== "investigating") return;
		phase = "finalizing";
		if (investigationTimeout) clearTimeout(investigationTimeout);
		session.setActiveToolsByName([]);
		void session.steer?.(PLANNER_FINALIZE_INSTRUCTION).catch(() => undefined);
	};
	const abortForBudget = (code: string, message: string): void => {
		if (budgetFailure) return;
		budgetFailure = new PlannerRuntimeError(code, message);
		void session.abort?.().catch(() => undefined);
	};
	const unsubscribe = session.subscribe?.((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			assistantTurns++;
			if (maxTurns !== undefined && assistantTurns > maxTurns) {
				abortForBudget("planner.max_turns", `Planner exceeded its ${maxTurns}-turn budget before producing a plan`);
				return;
			}
			if (event.message.stopReason === "toolUse") {
				if (phase !== "investigating" || investigationUsedTools) {
					abortForBudget(
						"planner.investigation_round_exceeded",
						"Planner attempted another tool round after the single investigation round",
					);
					return;
				}
				investigationUsedTools = true;
			}
		}
		if (event.type === "turn_end" && phase === "investigating" && investigationUsedTools) {
			requestFinalOutput();
		}
	});
	if (maxDurationMs !== undefined) {
		durationTimeout = setTimeout(
			() =>
				abortForBudget(
					"planner.max_duration",
					`Planner exceeded its ${maxDurationMs}ms duration budget before producing a plan`,
				),
			maxDurationMs,
		);
	}
	if (Number.isFinite(investigationTimeoutMs)) {
		investigationTimeout = setTimeout(
			() =>
				abortForBudget(
					"planner.investigation_timeout",
					`Planner exceeded its ${investigationTimeoutMs}ms investigation budget before finalizing`,
				),
			investigationTimeoutMs,
		);
	}

	try {
		const result = await executePromptEnvelope(session, envelope);
		if (budgetFailure) throw budgetFailure;
		return result;
	} catch (error) {
		if (budgetFailure) throw budgetFailure;
		throw error;
	} finally {
		if (durationTimeout) clearTimeout(durationTimeout);
		if (investigationTimeout) clearTimeout(investigationTimeout);
		unsubscribe?.();
	}
}

function extractJsonObject(text: string): string {
	const fenced = text.match(/```json[ \t]*\r?\n([\s\S]*?)```/i)?.[1]?.trim();
	const unlabeledFence = text.match(/```[ \t]*\r?\n([\s\S]*?)```/)?.[1]?.trim();
	const candidate = fenced ?? unlabeledFence ?? text;
	const start = candidate.indexOf("{");
	if (start < 0) {
		throw new PlannerRuntimeError("planner.output_not_json", "Planner response does not contain a JSON object");
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < candidate.length; index++) {
		const character = candidate[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			depth++;
		} else if (character === "}" && --depth === 0) {
			return candidate.slice(start, index + 1);
		}
	}
	throw new PlannerRuntimeError("planner.output_not_json", "Planner response contains an incomplete JSON object");
}

function parseJsonObject(text: string): unknown {
	const payload = extractJsonObject(text);
	try {
		return JSON.parse(payload);
	} catch (initialError) {
		const repaired = payload.replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u").replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
		if (repaired !== payload) {
			try {
				return JSON.parse(repaired);
			} catch {
				// Preserve the original parser error because it identifies the malformed model output.
			}
		}
		throw initialError;
	}
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

export function parsePlannerPlanContent(
	text: string,
	allowedVerificationCommands: readonly string[] = [],
): PlanContent {
	let value: unknown;
	try {
		value = parseJsonObject(text);
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
	let content: PlanContent = {
		goal: nonEmptyString(value.goal, "goal"),
		assumptions: stringArray(value.assumptions, "assumptions"),
		steps: value.steps.map(parsePlanStep),
		risks: value.risks.map(parsePlanRisk),
		verificationRequirements: value.verificationRequirements.map(parseVerificationRequirement),
	};
	const reviewerSteps = content.steps.filter(({ requiredAgentRole }) => requiredAgentRole === "reviewer");
	if (reviewerSteps.length > 0) {
		throw new PlannerRuntimeError(
			"planner.reviewer_step_not_allowed",
			`Planner must leave review to the Delivery Runtime instead of creating Reviewer steps: ${reviewerSteps.map(({ id }) => id).join(", ")}`,
		);
	}
	if (allowedVerificationCommands.length > 0) {
		const allowed = new Set(allowedVerificationCommands.map((command) => command.trim()));
		const unsupportedSteps = [
			...new Set(
				content.steps.flatMap(({ kind, command }) =>
					kind === "command" && command && !allowed.has(command.trim()) ? [command] : [],
				),
			),
		];
		if (unsupportedSteps.length > 0) {
			throw new PlannerRuntimeError(
				"planner.command_not_configured",
				`Planner introduced command steps that were not configured: ${unsupportedSteps.join("; ")}`,
			);
		}
		content = {
			...content,
			verificationRequirements: content.verificationRequirements.map((requirement) =>
				requirement.command && !allowed.has(requirement.command.trim())
					? {
							id: requirement.id,
							kind: requirement.kind,
							description: requirement.description,
							required: requirement.required,
						}
					: requirement,
			),
		};
	}
	return content;
}

export async function parsePlannerPlanContentWithRepair(
	session: PromptAgentSession,
	text: string,
	allowedVerificationCommands: readonly string[] = [],
): Promise<PlanContent> {
	try {
		return parsePlannerPlanContent(text, allowedVerificationCommands);
	} catch (error) {
		if (!(error instanceof PlannerRuntimeError)) throw error;
		const previousToolNames = session.getActiveToolNames();
		try {
			session.setActiveToolsByName([]);
			await session.prompt(
				[
					`PlanContent validation failed: ${error.message}`,
					"Do not call tools. Return only the corrected complete PlanContent JSON object.",
				].join("\n"),
				{ expandPromptTemplates: false, source: "extension" },
			);
			const repairedText = session.getLastAssistantText?.();
			if (!repairedText) {
				throw new PlannerRuntimeError(
					"planner.repair_output_missing",
					"Planner JSON repair completed without an Assistant response",
				);
			}
			return parsePlannerPlanContent(repairedText, allowedVerificationCommands);
		} finally {
			session.setActiveToolsByName(previousToolNames);
		}
	}
}
