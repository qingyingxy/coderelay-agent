import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContent } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function plan(): PlanContent {
	return {
		goal: "Inspect Team CLI",
		assumptions: [],
		steps: [
			{
				id: "inspect",
				title: "Inspect Team CLI",
				description: "Inspect Team CLI state",
				dependsOn: [],
				fileIntents: [{ path: "src/team.ts", action: "inspect", reason: "Inspect Team state" }],
				verificationRequirementIds: ["review"],
			},
		],
		risks: [],
		verificationRequirements: [
			{
				id: "review",
				kind: "review",
				description: "Review Team state",
				required: true,
			},
		],
	};
}

describe("Agent Team CLI", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("shows the live Task board, mailbox, and Task Proposals without another model call", async () => {
		harness = await createHarness();
		harness.session.enableWorkflowTracking();
		harness.setResponses([fauxAssistantMessage(JSON.stringify(plan()))]);

		await harness.session.prompt("/plan");
		await harness.session.prompt("Plan Team CLI inspection");
		await harness.session.prompt("/approve reviewed");
		await harness.session.prompt("/team");
		await harness.session.prompt("/team messages");
		await harness.session.prompt("/team proposals");
		await harness.session.prompt("/integration");
		await harness.session.prompt("/integration conflicts");

		const output = harness
			.eventsOfType("message_end")
			.map(({ message }) => message)
			.filter((message) => message.role === "custom" && message.customType === "workflow")
			.map(getMessageText)
			.join("\n");
		expect(output).toContain("Team | Workflow");
		expect(output).toContain("Tasks 0/1");
		expect(output).toContain("Team messages: (none)");
		expect(output).toContain("Team proposals: (none)");
		expect(output).toContain("Integration attempts: (none) | Writer capacity: 1");
		expect(output).toContain("Conflict Resolution Attempts: (none)");
		expect(harness.faux.state.callCount).toBe(1);
	});
});
