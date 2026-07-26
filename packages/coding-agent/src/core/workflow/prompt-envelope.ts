import { AGENT_PROFILE_ROLES, type AgentProfileRole } from "./agent-profile.ts";
import type { IsoDateTime, Task } from "./types.ts";

export const PROMPT_ENVELOPE_SCHEMA_VERSION = 1;

export type PromptTaskContext = Pick<
	Task,
	"id" | "workflowId" | "title" | "description" | "status" | "dependencyIds" | "verificationRequirements"
>;

export const PROMPT_CONTEXT_SOURCE_ORDER = [
	"agent_profile",
	"project_rule",
	"history",
	"user_request",
	"plan",
	"task",
	"handoff",
	"tool_schema",
] as const;
export type PromptContextSource = (typeof PROMPT_CONTEXT_SOURCE_ORDER)[number];

export interface PromptContextEntry {
	readonly id: string;
	readonly source: PromptContextSource;
	readonly content: string;
	readonly required: boolean;
}

export type PromptConstraintKind = "safety" | "permission" | "budget" | "workflow" | "output";

export interface PromptConstraint {
	readonly id: string;
	readonly kind: PromptConstraintKind;
	readonly description: string;
}

export interface PromptOutputSchema {
	readonly id: string;
	readonly version: string;
	readonly jsonSchema: Readonly<Record<string, unknown>>;
}

export interface PromptEnvelope {
	readonly schemaVersion: number;
	readonly promptVersion: string;
	readonly createdAt: IsoDateTime;
	readonly role: AgentProfileRole;
	readonly profileName: string;
	readonly task: PromptTaskContext;
	readonly context: readonly PromptContextEntry[];
	readonly toolNames: readonly string[];
	readonly constraints: readonly PromptConstraint[];
	readonly outputSchema: PromptOutputSchema;
}

export type CreatePromptEnvelopeInput = Omit<PromptEnvelope, "schemaVersion">;

export interface PromptEnvelopeViolation {
	readonly code: string;
	readonly message: string;
}

export class PromptEnvelopeError extends Error {
	readonly violations: readonly PromptEnvelopeViolation[];

	constructor(violations: readonly PromptEnvelopeViolation[]) {
		super(violations.map(({ message }) => message).join("; "));
		this.name = "PromptEnvelopeError";
		this.violations = violations;
	}
}

export function isPromptContextSource(value: unknown): value is PromptContextSource {
	return typeof value === "string" && PROMPT_CONTEXT_SOURCE_ORDER.some((source) => source === value);
}

export function orderPromptContextEntries(entries: readonly PromptContextEntry[]): readonly PromptContextEntry[] {
	return [...entries].sort((left, right) => {
		const leftIndex = PROMPT_CONTEXT_SOURCE_ORDER.indexOf(left.source);
		const rightIndex = PROMPT_CONTEXT_SOURCE_ORDER.indexOf(right.source);
		return (
			(leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
		);
	});
}

export function validatePromptEnvelope(envelope: PromptEnvelope): readonly PromptEnvelopeViolation[] {
	const violations: PromptEnvelopeViolation[] = [];
	const requireText = (value: string, code: string, message: string): void => {
		if (!value.trim()) {
			violations.push({ code, message });
		}
	};

	if (envelope.schemaVersion !== PROMPT_ENVELOPE_SCHEMA_VERSION) {
		violations.push({
			code: "prompt_envelope.unsupported_schema",
			message: `Unsupported PromptEnvelope schema version: ${envelope.schemaVersion}`,
		});
	}
	requireText(envelope.promptVersion, "prompt_envelope.version_required", "Prompt version is required");
	if (!Number.isFinite(Date.parse(envelope.createdAt))) {
		violations.push({
			code: "prompt_envelope.invalid_timestamp",
			message: "PromptEnvelope creation timestamp must be valid",
		});
	}
	if (!AGENT_PROFILE_ROLES.some((role) => role === envelope.role)) {
		violations.push({
			code: "prompt_envelope.invalid_role",
			message: `Unsupported PromptEnvelope role: ${envelope.role}`,
		});
	}
	requireText(envelope.profileName, "prompt_envelope.profile_required", "Agent Profile name is required");
	requireText(envelope.task.id, "prompt_envelope.task_id_required", "Task id is required");
	requireText(envelope.task.workflowId, "prompt_envelope.workflow_id_required", "Workflow id is required");
	requireText(envelope.task.title, "prompt_envelope.task_title_required", "Task title is required");
	requireText(envelope.task.description, "prompt_envelope.task_description_required", "Task description is required");

	if (envelope.context.length === 0) {
		violations.push({
			code: "prompt_envelope.context_required",
			message: "PromptEnvelope requires at least one context entry",
		});
	}
	const contextIds = new Set<string>();
	let previousContextSourceIndex = -1;
	for (const entry of envelope.context) {
		const id = entry.id.trim();
		requireText(entry.id, "prompt_envelope.context_id_required", "Context entry id is required");
		if (!isPromptContextSource(entry.source)) {
			violations.push({
				code: "prompt_envelope.invalid_context_source",
				message: `Context entry ${id} has an unsupported source: ${entry.source}`,
			});
		} else {
			const sourceIndex = PROMPT_CONTEXT_SOURCE_ORDER.indexOf(entry.source);
			if (sourceIndex < previousContextSourceIndex) {
				violations.push({
					code: "prompt_envelope.context_order",
					message: "PromptEnvelope context entries must use the canonical source order",
				});
			}
			previousContextSourceIndex = sourceIndex;
		}
		requireText(entry.content, "prompt_envelope.context_content_required", `Context entry ${id} requires content`);
		if (id && contextIds.has(id)) {
			violations.push({
				code: "prompt_envelope.duplicate_context",
				message: `Context entry id must be unique: ${id}`,
			});
		}
		contextIds.add(id);
	}

	const normalizedTools = envelope.toolNames.map((tool) => tool.trim());
	if (normalizedTools.some((tool) => !tool)) {
		violations.push({
			code: "prompt_envelope.invalid_tool",
			message: "PromptEnvelope tool names must be non-empty",
		});
	}
	if (new Set(normalizedTools).size !== normalizedTools.length) {
		violations.push({
			code: "prompt_envelope.duplicate_tool",
			message: "PromptEnvelope tool names must be unique",
		});
	}

	if (envelope.constraints.length === 0) {
		violations.push({
			code: "prompt_envelope.constraints_required",
			message: "PromptEnvelope requires at least one constraint",
		});
	}
	const constraintIds = new Set<string>();
	for (const constraint of envelope.constraints) {
		const id = constraint.id.trim();
		requireText(constraint.id, "prompt_envelope.constraint_id_required", "Constraint id is required");
		requireText(
			constraint.description,
			"prompt_envelope.constraint_description_required",
			`Constraint ${id} requires a description`,
		);
		if (id && constraintIds.has(id)) {
			violations.push({
				code: "prompt_envelope.duplicate_constraint",
				message: `Constraint id must be unique: ${id}`,
			});
		}
		constraintIds.add(id);
	}

	requireText(envelope.outputSchema.id, "prompt_envelope.output_schema_id_required", "Output Schema id is required");
	requireText(
		envelope.outputSchema.version,
		"prompt_envelope.output_schema_version_required",
		"Output Schema version is required",
	);
	if (
		envelope.outputSchema.jsonSchema === null ||
		typeof envelope.outputSchema.jsonSchema !== "object" ||
		Array.isArray(envelope.outputSchema.jsonSchema)
	) {
		violations.push({
			code: "prompt_envelope.invalid_output_schema",
			message: "Output Schema must be a JSON object",
		});
	}
	return violations;
}

export function createPromptEnvelope(input: CreatePromptEnvelopeInput): PromptEnvelope {
	const clonedInput = structuredClone(input);
	const envelope: PromptEnvelope = {
		schemaVersion: PROMPT_ENVELOPE_SCHEMA_VERSION,
		...clonedInput,
		context: orderPromptContextEntries(clonedInput.context),
	};
	const violations = validatePromptEnvelope(envelope);
	if (violations.length > 0) {
		throw new PromptEnvelopeError(violations);
	}
	return envelope;
}
