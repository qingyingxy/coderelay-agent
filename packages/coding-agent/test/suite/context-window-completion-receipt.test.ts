import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

it("exposes cut completion even when the handoff forgets it", async () => {
	const harness = await createHarness({
		settings: { contextManagement: { mode: "windowed" } },
		initialActiveToolNames: ["new_context"],
	});
	try {
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: "Implementation and tests are pending." }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("completedCuts=1");
				expect(text).toContain("This cut has already completed");
				expect(text).toContain("Implementation and tests are pending.");
				return fauxAssistantMessage("Continue implementation; do not repeat the completed cut.");
			},
		]);
		await harness.session.prompt("Cut once, then continue implementation.");
		expect(harness.eventsOfType("context_window_end")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	} finally {
		harness.cleanup();
	}
});
