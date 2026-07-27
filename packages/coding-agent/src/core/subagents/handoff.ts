import type { AgentId, AttemptId, HandoffId, IsoDateTime, TaskId, WorkflowId } from "../workflow/types.ts";
import type { AggregatedHandoff, Handoff, HandoffDraft, SourceLocation } from "./types.ts";

export class HandoffValidationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "HandoffValidationError";
		this.code = code;
	}
}

export interface HandoffIdentity {
	readonly id: HandoffId;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly agentId: AgentId;
	readonly createdAt: IsoDateTime;
}

function stringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new HandoffValidationError("handoff.invalid_field", `Handoff ${field} must be an array of strings`);
	}
	return value.map((item) => item.trim()).filter(Boolean);
}

function evidenceArray(value: unknown): readonly SourceLocation[] {
	if (!Array.isArray(value)) {
		throw new HandoffValidationError("handoff.invalid_evidence", "Handoff evidence must be an array");
	}
	return value.map((item) => {
		if (typeof item !== "object" || item === null) {
			throw new HandoffValidationError("handoff.invalid_evidence", "Handoff evidence entries must be objects");
		}
		const path = "path" in item && typeof item.path === "string" ? item.path.trim() : "";
		const line = "line" in item ? item.line : undefined;
		const note = "note" in item ? item.note : undefined;
		if (!path) {
			throw new HandoffValidationError("handoff.evidence_path_required", "Handoff evidence requires a path");
		}
		if (line !== undefined && (!Number.isInteger(line) || (line as number) < 1)) {
			throw new HandoffValidationError("handoff.invalid_evidence_line", `Invalid evidence line for ${path}`);
		}
		if (note !== undefined && typeof note !== "string") {
			throw new HandoffValidationError("handoff.invalid_evidence_note", `Invalid evidence note for ${path}`);
		}
		return {
			path,
			line: line as number | undefined,
			note: typeof note === "string" && note.trim() ? note.trim() : undefined,
		};
	});
}

function jsonPayload(text: string): unknown {
	const trimmed = text.trim();
	const withoutFence = trimmed
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	const start = withoutFence.indexOf("{");
	const end = withoutFence.lastIndexOf("}");
	if (start < 0 || end < start) {
		throw new HandoffValidationError("handoff.json_required", "Subagent response does not contain a JSON object");
	}
	try {
		return JSON.parse(withoutFence.slice(start, end + 1));
	} catch (error) {
		throw new HandoffValidationError(
			"handoff.invalid_json",
			`Subagent Handoff is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function parseHandoff(text: string, identity: HandoffIdentity): Handoff {
	const value = jsonPayload(text);
	if (typeof value !== "object" || value === null) {
		throw new HandoffValidationError("handoff.object_required", "Subagent Handoff must be a JSON object");
	}
	const conclusion = "conclusion" in value && typeof value.conclusion === "string" ? value.conclusion.trim() : "";
	if (!conclusion) {
		throw new HandoffValidationError("handoff.conclusion_required", "Subagent Handoff requires a conclusion");
	}
	const draft: HandoffDraft = {
		conclusion,
		evidence: evidenceArray("evidence" in value ? value.evidence : undefined),
		architectureFindings: stringArray(
			"architectureFindings" in value ? value.architectureFindings : undefined,
			"architectureFindings",
		),
		changedFiles: stringArray("changedFiles" in value ? value.changedFiles : undefined, "changedFiles"),
		verificationSummary: stringArray(
			"verificationSummary" in value ? value.verificationSummary : undefined,
			"verificationSummary",
		),
		risks: stringArray("risks" in value ? value.risks : undefined, "risks"),
		unfinishedItems: stringArray("unfinishedItems" in value ? value.unfinishedItems : undefined, "unfinishedItems"),
	};
	if (draft.verificationSummary.length === 0) {
		throw new HandoffValidationError(
			"handoff.verification_required",
			"Handoff verificationSummary requires at least one verification result",
		);
	}
	return { ...identity, ...draft };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
	return [...new Set(values)];
}

export function aggregateHandoffs(handoffs: readonly Handoff[]): AggregatedHandoff {
	const evidence = new Map<string, SourceLocation>();
	const changedByAgent = new Map<string, Set<AgentId>>();
	for (const handoff of handoffs) {
		for (const location of handoff.evidence) {
			evidence.set(`${location.path}:${location.line ?? ""}:${location.note ?? ""}`, structuredClone(location));
		}
		for (const path of handoff.changedFiles) {
			const agents = changedByAgent.get(path) ?? new Set<AgentId>();
			agents.add(handoff.agentId);
			changedByAgent.set(path, agents);
		}
	}
	return {
		handoffIds: handoffs.map(({ id }) => id),
		conclusions: handoffs.map(({ conclusion }) => conclusion),
		evidence: [...evidence.values()],
		architectureFindings: uniqueStrings(handoffs.flatMap(({ architectureFindings }) => architectureFindings)),
		changedFiles: uniqueStrings(handoffs.flatMap(({ changedFiles }) => changedFiles)),
		verificationSummary: uniqueStrings(handoffs.flatMap(({ verificationSummary }) => verificationSummary)),
		risks: uniqueStrings(handoffs.flatMap(({ risks }) => risks)),
		unfinishedItems: uniqueStrings(handoffs.flatMap(({ unfinishedItems }) => unfinishedItems)),
		modificationConflicts: [...changedByAgent.entries()]
			.filter(([, agentIds]) => agentIds.size > 1)
			.map(([path, agentIds]) => ({ path, agentIds: [...agentIds] })),
	};
}

export const STRUCTURED_HANDOFF_INSTRUCTION = [
	"Return only one JSON object with this exact shape:",
	'{"conclusion":"string","evidence":[{"path":"string","line":1,"note":"string"}],"architectureFindings":["string"],"changedFiles":["string"],"verificationSummary":["string"],"risks":["string"],"unfinishedItems":["string"]}',
	"All array fields are required. verificationSummary must contain at least one result; use empty arrays for other fields when there is nothing to report.",
	"Do not include the full conversation or Markdown outside the JSON object.",
].join("\n");
