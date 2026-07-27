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
