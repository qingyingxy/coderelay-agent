import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession as CodingAgentSession } from "../../src/core/agent-session.ts";
import { WORKFLOW_SNAPSHOT_CUSTOM_TYPE } from "../../src/core/workflow/event-log.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession hard context windows", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("cuts an idle conversation without deleting the persisted history", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer")]);
		await harness.session.prompt("first objective");
		const messageEntriesBefore = harness.sessionManager.getEntries().filter((entry) => entry.type === "message");

		const boundary = await harness.session.requestContextWindow("manual");

		expect(boundary).toMatchObject({
			type: "context_window",
			reason: "manual",
			windowIndex: 1,
			contextSeed: { noteEntryIds: [] },
		});
		expect(harness.session.contextWindowRuntimeState).toMatchObject({ phase: "idle", continueAfterCut: false });
		expect(harness.session.messages).toHaveLength(1);
		expect(harness.session.messages[0]).toMatchObject({ role: "custom", customType: "context-window" });
		expect(getMessageText(harness.session.messages[0])).toContain("Current objective: first objective");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual(
			messageEntriesBefore,
		);
		expect(harness.events.map(({ type }) => type).slice(-4)).toEqual([
			"context_window_requested",
			"context_window_start",
			"entry_appended",
			"context_window_end",
		]);
	});

	it("cuts after a tool result is persisted and continues from a Workflow Snapshot seed", async () => {
		let session: CodingAgentSession | undefined;
		let phaseDuringTool: string | undefined;
		const cutTool: AgentTool = {
			name: "request_cut",
			label: "Request context cut",
			description: "Request a context window cut",
			parameters: Type.Object({}),
			execute: async () => {
				if (!session) throw new Error("Test session is unavailable");
				await session.requestContextWindow("model", { continueAfterCut: true });
				phaseDuringTool = session.contextWindowRuntimeState.phase;
				return { content: [{ type: "text", text: "cut requested" }], details: {} };
			},
		};
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
			tools: [cutTool],
		});
		harnesses.push(harness);
		session = harness.session;
		harness.session.enableWorkflowTracking("direct");
		let secondProviderMessages: readonly { readonly role: string; readonly text: string }[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("request_cut", {}), { stopReason: "toolUse" }),
			(context) => {
				secondProviderMessages = context.messages.map((message) => ({
					role: message.role,
					text: getMessageText(message),
				}));
				return fauxAssistantMessage("continued after cut");
			},
		]);

		await harness.session.prompt("implement the tracked task");

		expect(phaseDuringTool).toBe("cut_pending");
		expect(secondProviderMessages).toHaveLength(1);
		expect(secondProviderMessages[0]?.text).toContain("Workflow Snapshot is authoritative");
		expect(secondProviderMessages[0]?.text).toContain("Current objective: implement the tracked task");
		const branch = harness.sessionManager.getBranch();
		const boundaryIndex = branch.findIndex((entry) => entry.type === "context_window");
		const toolResultIndex = branch.findIndex(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(toolResultIndex).toBeGreaterThanOrEqual(0);
		expect(boundaryIndex).toBeGreaterThan(toolResultIndex);
		const boundary = branch[boundaryIndex];
		if (boundary?.type !== "context_window") throw new Error("Expected a Context Window Entry");
		const snapshot = harness.sessionManager.getEntry(boundary.snapshotEntryId ?? "");
		expect(snapshot).toMatchObject({ type: "custom", customType: WORKFLOW_SNAPSHOT_CUSTOM_TYPE });
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
		expect(harness.eventsOfType("context_window_end")).toEqual([
			expect.objectContaining({
				reason: "model",
				continueAfterCut: true,
				snapshotEntryId: boundary.snapshotEntryId,
			}),
		]);
	});

	it("enters failed state and blocks sampling when the boundary cannot be persisted", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("objective");
		const activeMessages = [...harness.session.messages];
		vi.spyOn(harness.sessionManager, "appendContextWindow").mockImplementationOnce(() => {
			throw new Error("boundary write failed");
		});

		await expect(harness.session.requestContextWindow("manual")).rejects.toThrow("boundary write failed");

		expect(harness.session.contextWindowRuntimeState).toMatchObject({
			phase: "failed",
			reason: "manual",
			error: "boundary write failed",
		});
		expect(harness.session.messages).toEqual(activeMessages);
		expect(harness.eventsOfType("context_window_failed")).toEqual([
			{ type: "context_window_failed", reason: "manual", error: "boundary write failed" },
		]);
		await expect(harness.session.sendUserMessage("must not sample")).rejects.toThrow(
			"Context window management is failed",
		);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
