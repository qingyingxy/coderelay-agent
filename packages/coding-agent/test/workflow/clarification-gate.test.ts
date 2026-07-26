import { describe, expect, it } from "vitest";
import { ClarificationGateError, evaluateClarificationGate } from "../../src/core/workflow/clarification-gate.ts";

describe("clarification gate", () => {
	it("asks when missing information changes the implementation and has no safe default", () => {
		expect(
			evaluateClarificationGate([
				{
					id: "storage",
					question: "Should state be stored per project or globally?",
					impact: "architecture",
					changesImplementation: true,
				},
			]),
		).toEqual({
			required: true,
			questions: [
				{
					id: "storage",
					question: "Should state be stored per project or globally?",
					impact: "architecture",
				},
			],
			assumptions: [],
			ignoredCandidateIds: [],
		});
	});

	it("uses a safe default without interrupting the user", () => {
		expect(
			evaluateClarificationGate([
				{
					id: "test-command",
					question: "Which focused test command should run?",
					impact: "verification",
					changesImplementation: true,
					safeDefault: {
						answer: "Use the repository test command documented in AGENTS.md",
						reason: "The repository already defines the authoritative verification command",
					},
				},
			]),
		).toEqual({
			required: false,
			questions: [],
			assumptions: [
				{
					id: "test-command",
					answer: "Use the repository test command documented in AGENTS.md",
					reason: "The repository already defines the authoritative verification command",
				},
			],
			ignoredCandidateIds: [],
		});
	});

	it("ignores non-material preferences without asking", () => {
		expect(
			evaluateClarificationGate([
				{
					id: "wording",
					question: "Which equivalent status label do you prefer?",
					impact: "preference",
					changesImplementation: false,
				},
			]),
		).toEqual({
			required: false,
			questions: [],
			assumptions: [],
			ignoredCandidateIds: ["wording"],
		});
	});

	it("returns all blocking questions and records independent defaults", () => {
		const result = evaluateClarificationGate([
			{
				id: "target",
				question: "Which package should own the public API?",
				impact: "scope",
				changesImplementation: true,
			},
			{
				id: "format",
				question: "Which existing formatter should be used?",
				impact: "behavior",
				changesImplementation: true,
				safeDefault: {
					answer: "Use the formatter configured by the repository",
					reason: "It preserves project conventions",
				},
			},
			{
				id: "style",
				question: "Do you prefer a shorter internal helper name?",
				impact: "preference",
				changesImplementation: false,
			},
		]);

		expect(result.required).toBe(true);
		expect(result.questions.map(({ id }) => id)).toEqual(["target"]);
		expect(result.assumptions.map(({ id }) => id)).toEqual(["format"]);
		expect(result.ignoredCandidateIds).toEqual(["style"]);
	});

	it("rejects malformed or duplicate candidates", () => {
		expect(() =>
			evaluateClarificationGate([
				{
					id: "scope",
					question: "Which package is in scope?",
					impact: "scope",
					changesImplementation: true,
				},
				{
					id: " scope ",
					question: "Which directory is in scope?",
					impact: "scope",
					changesImplementation: true,
				},
			]),
		).toThrowError(expect.objectContaining({ code: "clarification.duplicate_id" }));

		expect(() =>
			evaluateClarificationGate([
				{
					id: "format",
					question: "Which format?",
					impact: "preference",
					changesImplementation: false,
					safeDefault: {
						answer: "",
						reason: "Use the existing style",
					},
				},
			]),
		).toThrow(ClarificationGateError);
	});
});
