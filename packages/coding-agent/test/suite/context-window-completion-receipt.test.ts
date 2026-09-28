import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

it("exposes cut completion without a model-authored handoff", async () => {
	const harness = await createHarness({
		settings: { contextManagement: { mode: "windowed" } },
		initialActiveToolNames: ["new_context"],
	});
	try {
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("completedCuts=1");
				expect(text).toContain("This cut has already completed");
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

it("carries a host-observed verification receipt across a hard cut without memory exploration", async () => {
	const harness = await createHarness({
		settings: { contextManagement: { mode: "windowed" } },
		initialActiveToolNames: ["live_verify", "new_context", "notes", "history"],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "live_verify",
					label: "Live verification",
					description: "Run the one-shot acceptance verification.",
					workflowReceipt: { kind: "verification" },
					parameters: Type.Object({ contract: Type.Literal("base") }),
					execute: async () => ({
						content: [{ type: "text", text: "Acceptance passed: 11/11" }],
						details: {},
					}),
				});
			},
		],
	});
	try {
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("live_verify", { contract: "base" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("Workflow Operation Receipt: kind=verification tool=live_verify status=succeeded");
				expect(text).toContain("Acceptance passed: 11/11");
				expect(text).toContain("do not query Notes or History merely to reconfirm them");
				return fauxAssistantMessage("Verification is already recorded; continue without Notes or History lookup.");
			},
		]);
		await harness.session.prompt("Run the base verification once, cut context, then continue.");
		expect(harness.eventsOfType("context_window_end")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(3);
		const toolStarts = harness.eventsOfType("tool_execution_start").map(({ toolName }) => toolName);
		expect(toolStarts).toEqual(["live_verify", "new_context"]);
	} finally {
		harness.cleanup();
	}
});
