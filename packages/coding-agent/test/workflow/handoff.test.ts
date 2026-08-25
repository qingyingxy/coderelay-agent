import { describe, expect, it } from "vitest";
import { aggregateHandoffs, HandoffValidationError, parseHandoff } from "../../src/index.ts";
import { NOW } from "./fixtures.ts";
import { SUBAGENT_HANDOFF, subagentHandoff } from "./subagent-fixtures.ts";

function identity(agentId: string, handoffId: string) {
	return {
		id: handoffId,
		workflowId: "workflow-1",
		taskId: `task-${agentId}`,
		attemptId: `attempt-${agentId}`,
		agentId,
		createdAt: NOW,
	};
}

describe("Structured Handoff", () => {
	it("parses the required compressed result without copying conversation history", () => {
		const handoff = parseHandoff(`\`\`\`json\n${SUBAGENT_HANDOFF}\n\`\`\``, identity("agent-1", "handoff-1"));

		expect(handoff).toMatchObject({
			id: "handoff-1",
			conclusion: "Inspection completed",
			evidence: [{ path: "src/index.ts", line: 12 }],
			architectureFindings: ["Workflow owns authoritative state"],
		});
	});

	it("prefers an explicit JSON fence over braces in surrounding commentary", () => {
		const handoff = parseHandoff(
			`Attempt {draft} ignored.\n\`\`\`json\n${SUBAGENT_HANDOFF}\n\`\`\`\nFinished {later}.`,
			identity("agent-1", "handoff-1"),
		);

		expect(handoff.conclusion).toBe("Inspection completed");
	});

	it("selects the final Handoff fence after an earlier package JSON fence", () => {
		const handoff = parseHandoff(
			`Repository metadata:\n\`\`\`json\n{"name":"fixture","type":"module"}\n\`\`\`\nFinal result:\n\`\`\`json\n${SUBAGENT_HANDOFF}\n\`\`\``,
			identity("agent-1", "handoff-1"),
		);

		expect(handoff.conclusion).toBe("Inspection completed");
	});

	it("selects a bare final Handoff after an earlier package JSON fence", () => {
		const handoff = parseHandoff(
			`Repository metadata:\n\`\`\`json\n{"name":"fixture","type":"module"}\n\`\`\`\nFinal result:\n${SUBAGENT_HANDOFF}`,
			identity("agent-1", "handoff-1"),
		);

		expect(handoff.conclusion).toBe("Inspection completed");
	});

	it("unwraps a Handoff object returned inside a common result envelope", () => {
		const handoff = parseHandoff(
			JSON.stringify({ handoff: JSON.parse(SUBAGENT_HANDOFF) }),
			identity("agent-1", "handoff-1"),
		);

		expect(handoff.conclusion).toBe("Inspection completed");
	});

	it("uses a non-empty summary alias when a model omits conclusion", () => {
		const handoff = parseHandoff(
			JSON.stringify({
				result: {
					summary: "Inspection completed through the summary field",
					evidence: [{ path: "src/index.ts", line: 12, note: "Entry point" }],
					architectureFindings: ["Workflow owns authoritative state"],
					changedFiles: [],
					verificationSummary: ["Reviewed result"],
					risks: [],
					unfinishedItems: [],
				},
			}),
			identity("agent-1", "handoff-1"),
		);

		expect(handoff.conclusion).toBe("Inspection completed through the summary field");
	});

	it("normalizes scalar fields and omitted optional arrays from a compact model result", () => {
		const handoff = parseHandoff(
			JSON.stringify({
				conclusion: "Implementation completed",
				architectureFindings: "The worker changed one file",
				changedFiles: "src/index.ts",
				verificationSummary: "node --test passed",
			}),
			identity("agent-1", "handoff-compact"),
		);

		expect(handoff).toMatchObject({
			conclusion: "Implementation completed",
			architectureFindings: ["The worker changed one file"],
			changedFiles: ["src/index.ts"],
			verificationSummary: ["node --test passed"],
			evidence: [],
			risks: [],
			unfinishedItems: [],
		});
	});

	it("merges adjacent JSON fragments that together form one Handoff", () => {
		const handoff = parseHandoff(
			[
				JSON.stringify({ conclusion: "Implementation contract prepared" }),
				JSON.stringify({
					evidence: [{ path: "src/index.ts", line: 12, note: "Entry point" }],
					architectureFindings: ["Workflow owns authoritative state"],
					changedFiles: [],
					verificationSummary: ["Planned node --test verification"],
					risks: [],
					unfinishedItems: [],
				}),
			].join("\n\n"),
			identity("agent-1", "handoff-split"),
		);

		expect(handoff).toMatchObject({
			conclusion: "Implementation contract prepared",
			evidence: [{ path: "src/index.ts", line: 12 }],
			verificationSummary: ["Planned node --test verification"],
		});
	});

	it("rejects oversized output before attempting structured parsing", () => {
		expect(() => parseHandoff(`{${"x".repeat(256 * 1024)}}`, identity("agent-1", "handoff-1"))).toThrow(
			/Handoff exceeds 262144 characters/,
		);
	});

	it("repairs non-JSON regex escapes inside otherwise valid Handoff strings", () => {
		const malformed = SUBAGENT_HANDOFF.replace("Inspection completed", String.raw`Use \s+ but preserve \p{L}`);

		const handoff = parseHandoff(malformed, identity("agent-1", "handoff-1"));

		expect(handoff.conclusion).toBe(String.raw`Use \s+ but preserve \p{L}`);
	});

	it("rejects incomplete output instead of marking the Task successful", () => {
		expect(() =>
			parseHandoff(
				JSON.stringify({
					conclusion: "",
					evidence: [],
					architectureFindings: [],
					changedFiles: [],
					verificationSummary: [],
					risks: [],
					unfinishedItems: [],
				}),
				identity("agent-1", "handoff-1"),
			),
		).toThrow(HandoffValidationError);
		expect(() =>
			parseHandoff(subagentHandoff({ verificationSummary: [] }), identity("agent-1", "handoff-2")),
		).toThrow(/verificationSummary/);
	});

	it("aggregates facts and identifies overlapping Writer ownership", () => {
		const first = parseHandoff(
			subagentHandoff({ changedFiles: ["src/shared.ts", "src/a.ts"] }),
			identity("agent-1", "handoff-1"),
		);
		const second = parseHandoff(
			subagentHandoff({
				conclusion: "Review completed",
				changedFiles: ["src/shared.ts", "src/b.ts"],
			}),
			identity("agent-2", "handoff-2"),
		);

		expect(aggregateHandoffs([first, second])).toMatchObject({
			handoffIds: ["handoff-1", "handoff-2"],
			changedFiles: ["src/shared.ts", "src/a.ts", "src/b.ts"],
			modificationConflicts: [{ path: "src/shared.ts", agentIds: ["agent-1", "agent-2"] }],
		});
	});
});
