import type { AgentId, AttemptId, HandoffId, IsoDateTime, TaskId, WorkflowId } from "../workflow/types.ts";
import type { AggregatedHandoff, Handoff, HandoffDraft, SourceLocation } from "./types.ts";

const MAX_HANDOFF_CHARACTERS = 256 * 1024;
const HANDOFF_FRAGMENT_FIELDS = new Set([
	"conclusion",
	"summary",
	"evidence",
	"architectureFindings",
	"changedFiles",
	"verificationSummary",
	"risks",
	"unfinishedItems",
]);

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
	if (value === undefined) {
		return [];
	}
	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized ? [normalized] : [];
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new HandoffValidationError("handoff.invalid_field", `Handoff ${field} must be an array of strings`);
	}
	return value.map((item) => item.trim()).filter(Boolean);
}

function evidenceArray(value: unknown): readonly SourceLocation[] {
	if (value === undefined) {
		return [];
	}
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

function completeJsonObjects(text: string): readonly string[] {
	const objects: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
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
		if (character === '"' && depth > 0) {
			inString = true;
			continue;
		}
		if (character === "{") {
			if (depth === 0) {
				start = index;
			}
			depth++;
			continue;
		}
		if (character !== "}" || depth === 0) {
			continue;
		}
		depth--;
		if (depth === 0 && start >= 0) {
			objects.push(text.slice(start, index + 1));
			start = -1;
		}
	}
	return objects;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function looksLikeHandoff(value: Record<string, unknown>): boolean {
	if ("conclusion" in value) {
		return true;
	}
	return (
		"summary" in value &&
		["evidence", "architectureFindings", "changedFiles", "verificationSummary", "risks", "unfinishedItems"].some(
			(field) => field in value,
		)
	);
}

function handoffObject(value: unknown): unknown {
	const record = objectRecord(value);
	if (!record) {
		return undefined;
	}
	if (looksLikeHandoff(record)) {
		return record;
	}
	for (const [key, nested] of Object.entries(record)) {
		if (!/^(handoff|result|output)$/i.test(key)) {
			continue;
		}
		const nestedRecord = objectRecord(nested);
		if (nestedRecord && looksLikeHandoff(nestedRecord)) {
			return nestedRecord;
		}
	}
	return undefined;
}

function mergedHandoffFragments(text: string): Record<string, unknown> | undefined {
	const fragments = completeJsonObjects(text).flatMap((candidate) => {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const record = objectRecord(parsed);
			if (!record) return [];
			const entries = Object.entries(record).filter(([field]) => HANDOFF_FRAGMENT_FIELDS.has(field));
			return entries.length > 0 ? [Object.fromEntries(entries)] : [];
		} catch {
			return [];
		}
	});
	if (
		fragments.length < 2 ||
		fragments.some(
			(fragment) =>
				(typeof fragment.conclusion === "string" || typeof fragment.summary === "string") &&
				"verificationSummary" in fragment,
		)
	) {
		return undefined;
	}
	const merged = Object.assign({}, ...fragments) as Record<string, unknown>;
	return (typeof merged.conclusion === "string" || typeof merged.summary === "string") &&
		"verificationSummary" in merged
		? merged
		: undefined;
}

function jsonPayload(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.length > MAX_HANDOFF_CHARACTERS) {
		throw new HandoffValidationError(
			"handoff.output_too_large",
			`Subagent Handoff exceeds ${MAX_HANDOFF_CHARACTERS} characters`,
		);
	}
	const mergedFragments = mergedHandoffFragments(trimmed);
	if (mergedFragments) {
		return mergedFragments;
	}
	const fenced = [...trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi)]
		.map((match) => match[1]?.trim())
		.filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
		.reverse();
	const candidates = [...fenced, ...[...completeJsonObjects(trimmed)].reverse()];
	let fallback: unknown;
	let parseError: unknown;
	for (const candidate of candidates) {
		const objects = completeJsonObjects(candidate);
		const payload = objects.at(-1) ?? candidate;
		try {
			let value: unknown;
			try {
				value = JSON.parse(payload);
			} catch (initialError) {
				parseError ??= initialError;
				const repaired = payload.replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u").replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
				if (repaired === payload) {
					continue;
				}
				value = JSON.parse(repaired);
			}
			const handoff = handoffObject(value);
			if (handoff !== undefined) {
				return handoff;
			}
			fallback ??= value;
		} catch (error) {
			parseError ??= error;
		}
	}
	if (fallback !== undefined) {
		return fallback;
	}
	if (parseError !== undefined) {
		throw new HandoffValidationError(
			"handoff.invalid_json",
			`Subagent Handoff is not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
		);
	}
	throw new HandoffValidationError("handoff.json_required", "Subagent response does not contain a JSON object");
}

export function parseHandoff(text: string, identity: HandoffIdentity): Handoff {
	const value = jsonPayload(text);
	const record = objectRecord(value);
	if (!record) {
		throw new HandoffValidationError("handoff.object_required", "Subagent Handoff must be a JSON object");
	}
	const explicitConclusion = typeof record.conclusion === "string" ? record.conclusion.trim() : "";
	const summary = typeof record.summary === "string" ? record.summary.trim() : "";
	const conclusion = explicitConclusion || summary;
	if (!conclusion) {
		throw new HandoffValidationError("handoff.conclusion_required", "Subagent Handoff requires a conclusion");
	}
	const draft: HandoffDraft = {
		conclusion,
		evidence: evidenceArray(record.evidence),
		architectureFindings: stringArray(record.architectureFindings, "architectureFindings"),
		changedFiles: stringArray(record.changedFiles, "changedFiles"),
		verificationSummary: stringArray(record.verificationSummary, "verificationSummary"),
		risks: stringArray(record.risks, "risks"),
		unfinishedItems: stringArray(record.unfinishedItems, "unfinishedItems"),
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
	"conclusion is mandatory and must be a non-empty string; if you draft a summary, copy it into conclusion.",
	"All array fields are required. verificationSummary must contain at least one result; use empty arrays for other fields when there is nothing to report.",
	"Keep the entire response under 16,000 characters. Limit each array to the 10 most important entries and keep each entry concise.",
	"Do not include the full conversation or Markdown outside the JSON object.",
].join("\n");

export const STRUCTURED_HANDOFF_RETRY_INSTRUCTION = [
	"The previous attempt did not produce a valid structured Handoff.",
	"Finish any necessary work or verification, then return exactly one compact JSON object immediately.",
	'Use this exact shape: {"conclusion":"...","evidence":[],"architectureFindings":[],"changedFiles":[],"verificationSummary":["..."],"risks":[],"unfinishedItems":[]}.',
	"conclusion must be a non-empty conclusion string, verificationSummary must contain at least one concrete result, and every other field must be an array (use [] when empty).",
	"Do not return prose, Markdown, or a summary-only object; if you write a summary, copy it into conclusion. Do not call another tool after emitting the JSON.",
].join(" ");
