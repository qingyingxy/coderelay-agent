import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPlannerPromptEnvelope,
	executePlannerPrompt,
	parsePlannerPlanContentWithRepair,
} from "../../src/core/workflow/planner-runtime.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function plan(path: string, action = "modify") {
	return JSON.stringify({
		goal: "Fix behavior",
		assumptions: [],
		risks: [],
		verificationRequirements: [],
		steps: [
			{
				id: "fix",
				title: "Fix",
				description: "Fix behavior",
				requiredAgentRole: "worker",
				dependsOn: [],
				fileIntents: [{ path, action, reason: "Fix behavior" }],
				verificationRequirementIds: [],
			},
		],
	});
}

function envelope(harness: Harness) {
	return createPlannerPromptEnvelope({
		createdAt: "2026-09-11T00:00:00.000Z",
		userRequest: "Fix behavior",
		activeToolNames: harness.session.getActiveToolNames(),
		task: {
			id: "root",
			workflowId: "workflow",
			title: "Fix",
			description: "Fix behavior",
			status: "pending",
			dependencyIds: [],
			verificationRequirements: [],
		},
	});
}

describe("Planner investigation evidence with faux models", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("recovers a failed find with ls/read and accepts grounded output", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "find",
					label: "find",
					description: "Unavailable search",
					parameters: Type.Object({}),
					execute: async () => {
						throw new Error("fd is not available and could not be downloaded");
					},
				},
				{
					name: "ls",
					label: "ls",
					description: "List fixture",
					parameters: Type.Object({ path: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "index.ts" }], details: {} }),
				},
				{
					name: "read",
					label: "read",
					description: "Read fixture",
					parameters: Type.Object({ path: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "export const value = 0;" }], details: {} }),
				},
			],
		});
		harnesses.push(harness);
		const path = join(harness.tempDir, "index.ts");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find", {})]),
			fauxAssistantMessage([fauxToolCall("ls", { path: harness.tempDir })]),
			fauxAssistantMessage([fauxToolCall("read", { path })]),
			fauxAssistantMessage(plan(path)),
		]);
		const originalTools = harness.session.getActiveToolNames();
		await executePlannerPrompt(harness.session, envelope(harness));
		await expect(
			parsePlannerPlanContentWithRepair(harness.session, harness.session.getLastAssistantText()!),
		).resolves.toMatchObject({ goal: "Fix behavior" });
		expect(getUserTexts(harness).join("\n")).toContain("Recover within the remaining budget");
		expect(harness.eventsOfType("tool_execution_end").map((event) => event.isError)).toEqual([true, false, false]);
		expect(harness.session.getActiveToolNames()).toEqual(originalTools);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([false, true])("blocks unread targets even after JSON repair (%s)", async (repair) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const text = plan(join(harness.tempDir, "unread.ts"));
		harness.setResponses([
			fauxAssistantMessage(repair ? "invalid" : text),
			...(repair ? [fauxAssistantMessage(text)] : []),
		]);
		await executePlannerPrompt(harness.session, envelope(harness));
		await expect(
			parsePlannerPlanContentWithRepair(harness.session, harness.session.getLastAssistantText()!),
		).rejects.toMatchObject({ code: "planner.evidence_missing" });
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([false, true])("requires a successful follow-up after truncated read (%s)", async (recover) => {
		let calls = 0;
		const harness = await createHarness({
			tools: [
				{
					name: "read",
					label: "read",
					description: "Read fixture",
					parameters: Type.Object({ path: Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: "source fragment" }],
						details: { truncation: { truncated: ++calls === 1 } },
					}),
				},
			],
		});
		harnesses.push(harness);
		const path = join(harness.tempDir, "index.ts");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })]),
			...(recover ? [fauxAssistantMessage([fauxToolCall("read", { path })])] : []),
			fauxAssistantMessage(plan(path)),
		]);
		await executePlannerPrompt(harness.session, envelope(harness));
		const parsed = parsePlannerPlanContentWithRepair(harness.session, harness.session.getLastAssistantText()!);
		if (recover) await expect(parsed).resolves.toMatchObject({ goal: "Fix behavior" });
		else await expect(parsed).rejects.toMatchObject({ code: "planner.evidence_missing" });
	});

	it("requests recovery for capped grep results without treating matches as read evidence", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "grep",
					label: "grep",
					description: "Capped search",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "index.ts:1:value" }],
						details: { matchLimitReached: 1 },
					}),
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage([fauxToolCall("grep", {})]), fauxAssistantMessage(plan("index.ts"))]);
		await executePlannerPrompt(harness.session, envelope(harness));
		expect(getUserTexts(harness).join("\n")).toContain("failed or truncated results from: grep");
		await expect(
			parsePlannerPlanContentWithRepair(harness.session, harness.session.getLastAssistantText()!),
		).rejects.toMatchObject({ code: "planner.evidence_missing" });
	});

	it("accepts new files with parent evidence and resets evidence on the next investigation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const path = join(harness.tempDir, "new.ts");
		writeFileSync(join(harness.tempDir, "existing.ts"), "export const value = 0;\n");
		harness.session.setActiveToolsByName(["read", "ls"]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ls", { path: harness.tempDir })]),
			fauxAssistantMessage(plan(path, "create")),
			fauxAssistantMessage(plan(path, "create")),
		]);
		await executePlannerPrompt(harness.session, envelope(harness));
		await expect(
			parsePlannerPlanContentWithRepair(harness.session, harness.session.getLastAssistantText()!),
		).resolves.toMatchObject({ goal: "Fix behavior" });
		await executePlannerPrompt(harness.session, envelope(harness));
		await expect(
			parsePlannerPlanContentWithRepair(harness.session, harness.session.getLastAssistantText()!),
		).rejects.toMatchObject({ code: "planner.evidence_missing" });
	});
});
