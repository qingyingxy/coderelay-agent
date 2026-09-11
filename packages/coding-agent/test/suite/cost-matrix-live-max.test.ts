import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { compactVerification } from "../../evals/cost-matrix/evidence.ts";
import { createHarness } from "./harness.ts";

describe("live candidate protocol", () => {
	it("bounds failed evidence without duplicating diagnostic snapshots", () => {
		const log = `FAIL: test_snapshot\n${"large-state".repeat(100000)}\nAssertionError: revision expected 42 actual 77`;
		const evidence = compactVerification(
			{
				passed: false,
				infrastructureComplete: true,
				detail: {
					backend: { exitCode: 1, summary: log },
					regression: { exitCode: 0 },
					browser: [{ name: "unchanged", passed: false, error: "uptime expected 77 actual 76", diagnostics: log }],
				},
			},
			log,
			"exit 1",
		);
		expect(evidence.length).toBeLessThan(10000);
		expect(evidence).toContain("revision expected 42 actual 77");
		expect(evidence).toContain("uptime expected 77 actual 76");
		expect(evidence).not.toContain("diagnostics");
		expect(JSON.parse(evidence).infrastructureComplete).toBe(true);
	});

	it.each(["max", "xhigh"] as const)("preserves %s through a tool-triggered context cut", async (level) => {
		const harness = await createHarness({
			models: [{ id: "reasoner", reasoning: true }],
			settings: { contextManagement: { mode: "windowed" } },
			initialActiveToolNames: ["new_context"],
		});
		try {
			harness.getModel().thinkingLevelMap = { max: "max", xhigh: "xhigh" };
			harness.session.setThinkingLevel(level);
			expect(harness.session.thinkingLevel).toBe(level);
			harness.session.enableWorkflowTracking("direct");
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("new_context", { handoff: "Pending: finish implementation; tests owned by host." }),
					{ stopReason: "toolUse" },
				),
				() => {
					expect(harness.session.thinkingLevel).toBe(level);
					return fauxAssistantMessage("Done");
				},
			]);
			await harness.session.prompt("Implement the scoped task");
			expect(harness.eventsOfType("context_window_end")).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.thinkingLevel).toBe(level);
		} finally {
			harness.cleanup();
		}
	});
});
