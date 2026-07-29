import type { AgentTranscriptEntry } from "./types.ts";

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|secret)/i;
const SECRET_PATTERNS = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9_]{8,}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
] as const;

export interface SubagentRetentionPolicy {
	readonly maxTranscriptEntries: number;
	readonly maxReleasedTranscriptEntries: number;
	readonly maxTranscriptEntryChars: number;
	readonly maxTranscriptChars: number;
	readonly maxTranscriptAgeMs: number;
	readonly maxReleasedTranscriptAgeMs: number;
	readonly maxEvents: number;
	readonly checkpointEveryRecords: number;
}

export const DEFAULT_SUBAGENT_RETENTION_POLICY: SubagentRetentionPolicy = {
	maxTranscriptEntries: 200,
	maxReleasedTranscriptEntries: 60,
	maxTranscriptEntryChars: 16_384,
	maxTranscriptChars: 256 * 1024,
	maxTranscriptAgeMs: 7 * 24 * 60 * 60_000,
	maxReleasedTranscriptAgeMs: 24 * 60 * 60_000,
	maxEvents: 500,
	checkpointEveryRecords: 50,
};

export class SubagentRetentionError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SubagentRetentionError";
		this.code = code;
	}
}

function positiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new SubagentRetentionError("subagent_retention.invalid_policy", `${name} must be a positive integer`);
	}
}

export function validateSubagentRetentionPolicy(policy: SubagentRetentionPolicy): void {
	positiveInteger(policy.maxTranscriptEntries, "maxTranscriptEntries");
	positiveInteger(policy.maxReleasedTranscriptEntries, "maxReleasedTranscriptEntries");
	positiveInteger(policy.maxTranscriptEntryChars, "maxTranscriptEntryChars");
	positiveInteger(policy.maxTranscriptChars, "maxTranscriptChars");
	positiveInteger(policy.maxTranscriptAgeMs, "maxTranscriptAgeMs");
	positiveInteger(policy.maxReleasedTranscriptAgeMs, "maxReleasedTranscriptAgeMs");
	positiveInteger(policy.maxEvents, "maxEvents");
	positiveInteger(policy.checkpointEveryRecords, "checkpointEveryRecords");
}

function sensitiveEnvironmentValues(environment: NodeJS.ProcessEnv): readonly string[] {
	return Object.entries(environment)
		.flatMap(([key, value]) =>
			SENSITIVE_KEY.test(key) && typeof value === "string" && value.length >= 8 ? [value] : [],
		)
		.sort((left, right) => right.length - left.length);
}

export class SecretRedactor {
	readonly #secretValues: readonly string[];

	constructor(secretValues: readonly string[] = sensitiveEnvironmentValues(process.env)) {
		this.#secretValues = [...new Set(secretValues.filter((value) => value.length >= 8))].sort(
			(left, right) => right.length - left.length,
		);
	}

	redactText(text: string): string {
		let redacted = text;
		for (const secret of this.#secretValues) {
			redacted = redacted.replaceAll(secret, "[REDACTED]");
		}
		for (const pattern of SECRET_PATTERNS) {
			redacted = redacted.replace(pattern, "[REDACTED]");
		}
		return redacted.replace(
			/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|secret)\s*[:=]\s*["']?)([^"',\s}]+(?:\s+\[REDACTED\])?)/gi,
			"$1[REDACTED]",
		);
	}

	redact<T>(value: T): T {
		return this.#redactUnknown(value, new WeakSet()) as T;
	}

	#redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
		if (typeof value === "string") {
			return this.redactText(value);
		}
		if (typeof value !== "object" || value === null) {
			return value;
		}
		if (seen.has(value)) {
			throw new SubagentRetentionError(
				"subagent_retention.circular_record",
				"Cannot redact a circular persistence record",
			);
		}
		seen.add(value);
		if (Array.isArray(value)) {
			const redacted = value.map((entry) => this.#redactUnknown(entry, seen));
			seen.delete(value);
			return redacted;
		}
		const redacted: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			redacted[key] =
				SENSITIVE_KEY.test(key) && typeof entry === "string" ? "[REDACTED]" : this.#redactUnknown(entry, seen);
		}
		seen.delete(value);
		return redacted;
	}
}

function truncateText(text: string, maximum: number): string {
	if (text.length <= maximum) {
		return text;
	}
	const suffix = `\n[truncated ${text.length - maximum} chars]`;
	if (suffix.length >= maximum) {
		return text.slice(0, maximum);
	}
	return `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

export function compactTranscript(
	entries: readonly AgentTranscriptEntry[],
	policy: SubagentRetentionPolicy,
	released: boolean,
	now = Date.now(),
): readonly AgentTranscriptEntry[] {
	validateSubagentRetentionPolicy(policy);
	const maximumEntries = released
		? Math.min(policy.maxTranscriptEntries, policy.maxReleasedTranscriptEntries)
		: policy.maxTranscriptEntries;
	const maximumAge = released
		? Math.min(policy.maxTranscriptAgeMs, policy.maxReleasedTranscriptAgeMs)
		: policy.maxTranscriptAgeMs;
	const cutoff = now - maximumAge;
	const maximumEntryChars = Math.min(policy.maxTranscriptEntryChars, policy.maxTranscriptChars);
	const sanitized = entries
		.filter(({ occurredAt }) => {
			const occurredAtMs = Date.parse(occurredAt);
			return !Number.isFinite(occurredAtMs) || occurredAtMs >= cutoff;
		})
		.map((entry) => ({
			...entry,
			text: truncateText(entry.text, maximumEntryChars),
		}));
	const firstPrompt = sanitized.find(({ type }) => type === "prompt");
	const retained: AgentTranscriptEntry[] = [];
	let characters = 0;
	for (let index = sanitized.length - 1; index >= 0 && retained.length < maximumEntries; index--) {
		const entry = sanitized[index]!;
		if (characters + entry.text.length > policy.maxTranscriptChars && retained.length > 0) {
			continue;
		}
		retained.push(entry);
		characters += entry.text.length;
	}
	retained.reverse();
	if (firstPrompt && !retained.some(({ sequence }) => sequence === firstPrompt.sequence)) {
		const prompt = {
			...firstPrompt,
			text: truncateText(firstPrompt.text, maximumEntryChars),
		};
		while (
			retained.length > 0 &&
			(retained.length >= maximumEntries || characters + prompt.text.length > policy.maxTranscriptChars)
		) {
			characters -= retained.shift()!.text.length;
		}
		retained.unshift(prompt);
		characters += prompt.text.length;
	}
	const removed = sanitized.length - retained.length;
	if (removed < 1 || retained.length >= maximumEntries) {
		return retained;
	}
	const first = retained[0] ?? sanitized.at(-1);
	if (!first) {
		return retained;
	}
	const summary: AgentTranscriptEntry = {
		sequence: Math.max(0, first.sequence - 1),
		agentId: first.agentId,
		type: "activity",
		text: `[Compacted ${removed} earlier transcript entries]`,
		occurredAt: first.occurredAt,
	};
	if (characters + summary.text.length <= policy.maxTranscriptChars) {
		retained.unshift(summary);
	}
	return retained;
}
