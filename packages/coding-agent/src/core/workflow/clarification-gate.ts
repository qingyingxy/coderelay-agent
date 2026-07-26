export type ClarificationImpact = "scope" | "behavior" | "architecture" | "safety" | "verification" | "preference";

export interface ClarificationDefault {
	readonly answer: string;
	readonly reason: string;
}

export interface ClarificationCandidate {
	readonly id: string;
	readonly question: string;
	readonly impact: ClarificationImpact;
	readonly changesImplementation: boolean;
	readonly safeDefault?: ClarificationDefault;
}

export interface RequiredClarification {
	readonly id: string;
	readonly question: string;
	readonly impact: ClarificationImpact;
}

export interface ClarificationAssumption {
	readonly id: string;
	readonly answer: string;
	readonly reason: string;
}

export interface ClarificationGateResult {
	readonly required: boolean;
	readonly questions: readonly RequiredClarification[];
	readonly assumptions: readonly ClarificationAssumption[];
	readonly ignoredCandidateIds: readonly string[];
}

export class ClarificationGateError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ClarificationGateError";
		this.code = code;
	}
}

export function evaluateClarificationGate(candidates: readonly ClarificationCandidate[]): ClarificationGateResult {
	const ids = new Set<string>();
	const questions: RequiredClarification[] = [];
	const assumptions: ClarificationAssumption[] = [];
	const ignoredCandidateIds: string[] = [];

	for (const candidate of candidates) {
		const id = candidate.id.trim();
		const question = candidate.question.trim();
		if (!id) {
			throw new ClarificationGateError("clarification.id_required", "Clarification candidate id is required");
		}
		if (ids.has(id)) {
			throw new ClarificationGateError(
				"clarification.duplicate_id",
				`Clarification candidate id must be unique: ${id}`,
			);
		}
		ids.add(id);
		if (!question) {
			throw new ClarificationGateError(
				"clarification.question_required",
				`Clarification question is required for candidate ${id}`,
			);
		}

		if (candidate.safeDefault) {
			const answer = candidate.safeDefault.answer.trim();
			const reason = candidate.safeDefault.reason.trim();
			if (!answer || !reason) {
				throw new ClarificationGateError(
					"clarification.invalid_default",
					`Safe default for candidate ${id} requires an answer and reason`,
				);
			}
			assumptions.push({ id, answer, reason });
			continue;
		}
		if (candidate.changesImplementation) {
			questions.push({ id, question, impact: candidate.impact });
			continue;
		}
		ignoredCandidateIds.push(id);
	}

	return {
		required: questions.length > 0,
		questions,
		assumptions,
		ignoredCandidateIds,
	};
}
