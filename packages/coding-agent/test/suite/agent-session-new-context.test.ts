import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession new context triggers", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("does not expose new_context in summary mode", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.getAllTools().map(({ name }) => name)).not.toContain("new_context");
		expect(harness.session.getActiveToolNames()).not.toContain("new_context");
	});

	it("exposes and activates new_context in windowed mode while respecting exclusions", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		const excludedHarness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
			excludedToolNames: ["new_context"],
		});
		harnesses.push(harness, excludedHarness);

		expect(harness.session.getAllTools().map(({ name }) => name)).toContain("new_context");
		expect(harness.session.getActiveToolNames()).toContain("new_context");
		expect(excludedHarness.session.getAllTools().map(({ name }) => name)).not.toContain("new_context");
		expect(excludedHarness.session.getActiveToolNames()).not.toContain("new_context");
	});

	it("persists the tool result before cutting and continues from the new seed", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		let secondProviderMessages: readonly { readonly role: string; readonly text: string }[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			(context) => {
				secondProviderMessages = context.messages.map((message) => ({
					role: message.role,
					text: getMessageText(message),
				}));
				return fauxAssistantMessage("continued in the fresh window");
			},
		]);

		await harness.session.prompt("remember this objective");

		const branch = harness.sessionManager.getBranch();
		const toolResultIndex = branch.findIndex(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		const boundaryIndex = branch.findIndex((entry) => entry.type === "context_window");
		expect(toolResultIndex).toBeGreaterThanOrEqual(0);
		expect(boundaryIndex).toBeGreaterThan(toolResultIndex);
		expect(secondProviderMessages).toHaveLength(1);
		expect(secondProviderMessages[0]?.role).toBe("user");
		expect(secondProviderMessages[0]?.text).toContain("Current objective: remember this objective");
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
		expect(harness.eventsOfType("context_window_end")).toEqual([
			expect.objectContaining({ reason: "model", continueAfterCut: true }),
		]);
	});

	it("executes /new-context without calling the provider or persisting presentation output", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("unused")]);
		await harness.session.prompt("manual objective");

		await harness.session.prompt("/new-context");

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_window")).toHaveLength(1);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "context-window-command"),
		).toBe(false);
		expect(harness.session.messages).toHaveLength(1);
		expect(getMessageText(harness.session.messages[0])).toContain("Current objective: manual objective");
		const lastMessage = harness.eventsOfType("message_end").at(-1)?.message;
		expect(lastMessage).toMatchObject({ role: "custom", customType: "context-window-command", display: true });
		expect(lastMessage ? getMessageText(lastMessage) : "").toContain("Started a fresh context window");
	});

	it("shows usage for /new-context arguments without cutting", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/new-context extra");

		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.session.messages).toEqual([]);
		const lastMessage = harness.eventsOfType("message_end").at(-1)?.message;
		expect(lastMessage ? getMessageText(lastMessage) : "").toBe("Usage: /new-context");
	});

	it("rejects /new-context while the agent is streaming", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
			tools: [waitTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await sawToolStart;

		await expect(harness.session.prompt("/new-context")).rejects.toThrow(
			"/new-context can only be used while context-window management is idle",
		);

		releaseToolExecution?.();
		await promptPromise;
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_window")).toBe(false);
	});

	it("requires Workflow context for the model tool in hybrid mode", async () => {
		const withoutWorkflow = await createHarness({ settings: { contextManagement: { mode: "hybrid" } } });
		const withWorkflow = await createHarness({ settings: { contextManagement: { mode: "hybrid" } } });
		harnesses.push(withoutWorkflow, withWorkflow);
		withoutWorkflow.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued after rejection"),
		]);

		await withoutWorkflow.session.prompt("plain chat");

		expect(withoutWorkflow.sessionManager.getEntries().some((entry) => entry.type === "context_window")).toBe(false);
		const rejectedResult = withoutWorkflow.session.messages.find((message) => message.role === "toolResult");
		expect(rejectedResult ? getMessageText(rejectedResult) : "").toContain(
			"new_context requires an active Workflow context provider in hybrid mode",
		);

		withWorkflow.session.enableWorkflowTracking("direct");
		withWorkflow.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued with workflow seed"),
		]);
		await withWorkflow.session.prompt("tracked task");

		expect(withWorkflow.sessionManager.getEntries().some((entry) => entry.type === "context_window")).toBe(true);
		expect(withWorkflow.eventsOfType("context_window_end")).toEqual([
			expect.objectContaining({ reason: "model", continueAfterCut: true }),
		]);
	});
});
