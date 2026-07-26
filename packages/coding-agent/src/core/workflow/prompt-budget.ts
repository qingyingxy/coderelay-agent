import type { PromptContextSource, PromptEnvelope } from "./prompt-envelope.ts";
import { validatePromptEnvelope } from "./prompt-envelope.ts";

export type PromptTokenEstimator = (text: string) => number;

export interface PromptBudgetOptions {
	readonly maxInputTokens: number;
	readonly reservedTokens?: number;
	readonly estimateTokens: PromptTokenEstimator;
}

export interface RemovedPromptContext {
	readonly id: string;
	readonly source: PromptContextSource;
	readonly estimatedTokens: number;
	readonly reason: "input_budget";
}

export interface PromptBudgetResult {
	readonly envelope: PromptEnvelope;
	readonly estimatedTokensBefore: number;
	readonly estimatedTokensAfter: number;
	readonly maxInputTokens: number;
	readonly reservedTokens: number;
	readonly removedContext: readonly RemovedPromptContext[];
}

export class PromptBudgetError extends Error {
	readonly code: string;
	readonly requiredTokens?: number;
	readonly maxInputTokens?: number;

	constructor(code: string, message: string, requiredTokens?: number, maxInputTokens?: number) {
		super(message);
		this.name = "PromptBudgetError";
		this.code = code;
		this.requiredTokens = requiredTokens;
		this.maxInputTokens = maxInputTokens;
	}
}

const ALWAYS_PROTECTED_SOURCES: ReadonlySet<PromptContextSource> = new Set(["agent_profile", "user_request", "task"]);

const TRIMMABLE_SOURCE_PRIORITY: readonly PromptContextSource[] = [
	"history",
	"handoff",
	"plan",
	"project_rule",
	"tool_schema",
];

export function applyPromptBudget(envelope: PromptEnvelope, options: PromptBudgetOptions): PromptBudgetResult {
	if (!Number.isFinite(options.maxInputTokens) || options.maxInputTokens <= 0) {
		throw new PromptBudgetError("prompt_budget.invalid_limit", "Input token budget must be a positive number");
	}
	const reservedTokens = options.reservedTokens ?? 0;
	if (!Number.isFinite(reservedTokens) || reservedTokens < 0 || reservedTokens >= options.maxInputTokens) {
		throw new PromptBudgetError(
			"prompt_budget.invalid_reserve",
			"Reserved tokens must be non-negative and smaller than the input token budget",
		);
	}
	const envelopeViolations = validatePromptEnvelope(envelope);
	if (envelopeViolations.length > 0) {
		throw new PromptBudgetError("prompt_budget.invalid_envelope", "Cannot budget an invalid PromptEnvelope");
	}

	const estimate = (text: string): number => {
		const tokens = options.estimateTokens(text);
		if (!Number.isFinite(tokens) || tokens < 0) {
			throw new PromptBudgetError(
				"prompt_budget.invalid_estimate",
				"Token estimator must return a non-negative number",
			);
		}
		return Math.ceil(tokens);
	};

	const fixedTokens = estimate(
		JSON.stringify({
			schemaVersion: envelope.schemaVersion,
			promptVersion: envelope.promptVersion,
			role: envelope.role,
			profileName: envelope.profileName,
			task: envelope.task,
			toolNames: envelope.toolNames,
			constraints: envelope.constraints,
			outputSchema: envelope.outputSchema,
		}),
	);
	const contextTokens = new Map<string, number>();
	for (const entry of envelope.context) {
		contextTokens.set(entry.id, estimate(JSON.stringify(entry)));
	}

	const estimatedTokensBefore =
		reservedTokens + fixedTokens + [...contextTokens.values()].reduce((total, tokens) => total + tokens, 0);
	if (estimatedTokensBefore <= options.maxInputTokens) {
		return {
			envelope: structuredClone(envelope),
			estimatedTokensBefore,
			estimatedTokensAfter: estimatedTokensBefore,
			maxInputTokens: options.maxInputTokens,
			reservedTokens,
			removedContext: [],
		};
	}

	const protectedTokens =
		reservedTokens +
		fixedTokens +
		envelope.context
			.filter((entry) => entry.required || ALWAYS_PROTECTED_SOURCES.has(entry.source))
			.reduce((total, entry) => total + (contextTokens.get(entry.id) ?? 0), 0);
	if (protectedTokens > options.maxInputTokens) {
		throw new PromptBudgetError(
			"prompt_budget.protected_content_exceeds_limit",
			"Required Prompt content exceeds the input token budget",
			protectedTokens,
			options.maxInputTokens,
		);
	}

	let estimatedTokensAfter = estimatedTokensBefore;
	const removedContext: RemovedPromptContext[] = [];
	const removedIds = new Set<string>();
	for (const source of TRIMMABLE_SOURCE_PRIORITY) {
		for (const entry of envelope.context) {
			if (
				estimatedTokensAfter <= options.maxInputTokens ||
				entry.source !== source ||
				entry.required ||
				ALWAYS_PROTECTED_SOURCES.has(entry.source)
			) {
				continue;
			}
			const estimatedTokens = contextTokens.get(entry.id) ?? 0;
			removedIds.add(entry.id);
			removedContext.push({
				id: entry.id,
				source: entry.source,
				estimatedTokens,
				reason: "input_budget",
			});
			estimatedTokensAfter -= estimatedTokens;
		}
	}

	if (estimatedTokensAfter > options.maxInputTokens) {
		throw new PromptBudgetError(
			"prompt_budget.no_trimmable_context",
			"Prompt exceeds the input token budget and no additional context can be removed",
			estimatedTokensAfter,
			options.maxInputTokens,
		);
	}

	return {
		envelope: {
			...structuredClone(envelope),
			context: envelope.context.filter((entry) => !removedIds.has(entry.id)).map((entry) => structuredClone(entry)),
		},
		estimatedTokensBefore,
		estimatedTokensAfter,
		maxInputTokens: options.maxInputTokens,
		reservedTokens,
		removedContext,
	};
}
