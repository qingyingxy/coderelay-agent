import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowController } from "../../src/core/workflow/controller.ts";
import { SessionWorkflowEventLog } from "../../src/core/workflow/event-log.ts";
import { WorkflowStore } from "../../src/core/workflow/stores.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const pending = "Modified but unverified: safe_upsert transaction.";
const next = "Next action: add and run safe_upsert checks.";

describe("successive Direct handoffs", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	// Faux scripts both compliant and lossy replies; this tests transport, not model obedience.
	it.each(["carry", "omit-parameter", "drop-item", "verified"] as const)(
		"records %s after existing-suite success without extra model calls",
		async (scenario) => {
			let existingChecks = 0;
			let upsertChecks = 0;
			const tools: AgentTool[] = [
				{
					name: "verify_existing",
					label: "Existing checks",
					description: "Synthetic existing tests; no safe_upsert coverage",
					parameters: Type.Object({}),
					execute: async () => {
						existingChecks++;
						return {
							content: [{ type: "text", text: "Existing suite: 1060 passed. Covers insert and docs only." }],
							details: {},
						};
					},
				},
				{
					name: "verify_upsert",
					label: "Upsert checks",
					description: "Synthetic safe_upsert validation",
					parameters: Type.Object({}),
					execute: async () => {
						upsertChecks++;
						return {
							content: [{ type: "text", text: "safe_upsert success, rollback and strict checks passed." }],
							details: {},
						};
					},
				},
			];
			const harness = await createHarness({
				settings: { contextManagement: { mode: "windowed" } },
				tools,
				initialActiveToolNames: ["new_context", "verify_existing", "verify_upsert", "history"],
			});
			harnesses.push(harness);
			harness.session.enableWorkflowTracking("direct");
			const first = `${pending} ${next}`;
			let second = "";
			let third = "";
			let existingEvidenceId: string | undefined;
			let upsertEvidenceId: string | undefined;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("new_context", { handoff: first }), { stopReason: "toolUse" }),
				(context) => {
					expect(context.messages.map(getMessageText).join("\n")).toContain(pending);
					return fauxAssistantMessage(fauxToolCall("verify_existing", {}), { stopReason: "toolUse" });
				},
				() => {
					const entry = harness.sessionManager
						.getBranch()
						.filter(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolName === "verify_existing",
						)
						.at(-1);
					if (!entry) throw new Error("Missing existing-suite evidence");
					existingEvidenceId = entry.id;
					second = `${pending} ${next} Existing suite passed; evidence=${entry.id}; no upsert coverage.`;
					return fauxAssistantMessage(fauxToolCall("new_context", { handoff: second }), { stopReason: "toolUse" });
				},
				(context) => {
					const text = context.messages.map(getMessageText).join("\n");
					expect(text).toContain(second);
					expect(text).toContain("Existing-suite success alone does not resolve untested requirements.");
					const handoffTool = context.tools?.find((tool) => tool.name === "new_context");
					expect(JSON.stringify(handoffTool?.parameters)).toContain("Carry forward every unresolved item");
					return fauxAssistantMessage(
						fauxToolCall(scenario === "verified" ? "verify_upsert" : "verify_existing", {}),
						{ stopReason: "toolUse" },
					);
				},
				() => {
					if (scenario === "verified") {
						const entry = harness.sessionManager
							.getBranch()
							.filter(
								(entry) =>
									entry.type === "message" &&
									entry.message.role === "toolResult" &&
									entry.message.toolName === "verify_upsert",
							)
							.at(-1);
						if (!entry) throw new Error("Missing upsert evidence");
						upsertEvidenceId = entry.id;
						third = `Verified: safe_upsert success, rollback and strict checks; evidence=${entry.id}. Next action: final review.`;
					} else if (scenario === "drop-item") {
						third = `Existing suite: 1060 passed; evidence=${existingEvidenceId}. Next action: final review.`;
					} else {
						third = second;
					}
					return fauxAssistantMessage(
						fauxToolCall("new_context", scenario === "omit-parameter" ? {} : { handoff: third }),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const text = context.messages.map(getMessageText).join("\n");
					expect(text).toContain(third);
					expect(harness.session.getWorkflowView()?.workflow.status).toBe("executing");
					if (scenario === "carry" || scenario === "omit-parameter") expect(text).toContain(pending);
					else expect(text).not.toContain(pending);
					return fauxAssistantMessage(
						fauxToolCall("history", {
							action: "search",
							query: pending,
						}),
						{ stopReason: "toolUse" },
					);
				},
				() => fauxAssistantMessage("Report the actual verification scope."),
			]);
			await harness.session.prompt("Implement import behavior and validate the required paths.");
			expect(harness.faux.state.callCount).toBe(7);
			expect(existingChecks).toBe(scenario === "verified" ? 1 : 2);
			expect(upsertChecks).toBe(scenario === "verified" ? 1 : 0);
			expect(harness.eventsOfType("context_window_end")).toHaveLength(3);
			expect(harness.eventsOfType("history_query").some((event) => event.resultCount > 0)).toBe(true);
			const branch = harness.sessionManager.getBranch();
			expect(
				branch.filter(
					(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
				),
			).toEqual([]);
			expect(branch.filter((entry) => entry.type === "compaction")).toEqual([]);
			expect(harness.sessionManager.getMemoryNotes()).toEqual([]);
			const replay = new WorkflowController(
				new SessionWorkflowEventLog(harness.sessionManager),
				new WorkflowStore(),
			);
			const workflow = harness.session.getWorkflowView()?.workflow;
			if (!workflow) throw new Error("Missing workflow");
			expect(replay.getRootTask(workflow.id)?.description).toBe(third);
			if (upsertEvidenceId) expect(harness.sessionManager.getEntry(upsertEvidenceId)).toBeDefined();
			if (scenario === "drop-item") {
				// Known limitation: replacement accepts an omission even though no upsert check ran.
				expect(upsertChecks).toBe(0);
				expect(third).not.toContain("safe_upsert");
			}
		},
	);
});
