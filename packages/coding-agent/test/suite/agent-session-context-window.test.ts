import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession as CodingAgentSession } from "../../src/core/agent-session.ts";
import { WORKFLOW_SNAPSHOT_CUSTOM_TYPE } from "../../src/core/workflow/event-log.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession hard context windows", () => {
	const harnesses: Harness[] = [];

	it("continues through verification from a deterministic Workflow projection without a summary request", async () => {
		let checks = 0;
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
			initialActiveToolNames: ["new_context", "verify_fixture"],
			tools: [
				{
					name: "verify_fixture",
					label: "Verify",
					description: "Run regression checks",
					parameters: Type.Object({}),
					execute: async () => {
						checks++;
						return { content: [{ type: "text", text: "upsert, CLI and tracing passed" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("Workflow Snapshot is task-control authority");
				expect(text).toContain("Current objective: Implement safe import");
				expect(harness.session.getWorkflowView()?.workflow.status).toBe("executing");
				return fauxAssistantMessage(fauxToolCall("verify_fixture", {}), { stopReason: "toolUse" });
			},
			() => {
				expect(checks).toBe(1);
				return fauxAssistantMessage("Local checks passed.");
			},
		]);
		await harness.session.prompt("Implement safe import and check upsert, CLI help and SQL tracing");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("context_window_end")).toHaveLength(1);
		expect(harness.sessionManager.getMemoryNotes()).toEqual([]);
	});

	it("preserves the original Workflow objective across successive cuts", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
			initialActiveToolNames: ["new_context"],
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("Current objective: Original requirements");
				return fauxAssistantMessage("Original objective retained.");
			},
		]);
		await harness.session.prompt("Original requirements");
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError)
				.map((entry) => (entry.type === "message" ? getMessageText(entry.message) : "")),
		).toEqual([]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("context_window_end")).toHaveLength(2);
	});

	it("injects only the current Workflow and directs cross-Workflow gaps to matching Notes", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
			initialActiveToolNames: ["new_context", "notes", "history"],
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage("Backend transport contract established; transport-v1 passed."),
			fauxAssistantMessage("Retry metadata preserved; retry-v2 passed."),
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("Current objective: Extend the client while preserving the earlier contracts");
				expect(text).not.toContain("Recent Workflow Context:");
				expect(text).not.toContain("Backend transport contract established; transport-v1 passed.");
				expect(text).not.toContain("Retry metadata preserved; retry-v2 passed.");
				expect(text).toContain("If the current request depends on an earlier Workflow");
				expect(text).toContain("read the matching Note instead of guessing the missing user contract from code");
				expect(text).toContain("Use History only when that Note lacks exact wording");
				return fauxAssistantMessage("Client extension completed from the current Workflow.");
			},
		]);

		await harness.session.prompt("Establish the backend transport contract");
		await harness.session.prompt("Preserve retry metadata");
		await harness.session.prompt("Extend the client while preserving the earlier contracts");

		const memoryCalls = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [],
			)
			.filter((content) => content.type === "toolCall" && (content.name === "notes" || content.name === "history"));
		expect(memoryCalls).toEqual([]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("context_window_end")).toHaveLength(1);
	});

	it.each([40000, 53000])("handles %i tokens before the next call in a continuous tool loop", async (inputTokens) => {
		let calls = 0;
		const tool: AgentTool = {
			name: "inspect_fixture",
			label: "Inspect",
			description: "Inspect a fixture",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [
					{ type: "text", text: `persisted tool result${++calls === 1 ? "x".repeat(inputTokens * 4) : ""}` },
				],
				details: {},
			}),
		};
		const harness = await createHarness({
			models: [{ id: "test", contextWindow: 64000, maxTokens: 4000 }],
			tools: [tool],
			initialActiveToolNames: ["inspect_fixture", "new_context"],
			settings: { contextManagement: { mode: "windowed", reserveTokens: 16000 } },
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		const highUsage = fauxAssistantMessage(fauxToolCall("inspect_fixture", {}), { stopReason: "toolUse" });
		harness.setResponses([
			highUsage,
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				if (inputTokens < 51200) {
					expect(text).toContain("approaching its hard token limit");
					expect(text).toContain("persisted tool result");
					expect(harness.eventsOfType("context_window_warning")).toHaveLength(1);
				} else {
					expect(text).toContain("Workflow Snapshot is task-control authority");
					expect(text).not.toContain("persisted tool result");
					expect(harness.eventsOfType("context_window_end")).toHaveLength(1);
				}
				return fauxAssistantMessage(
					inputTokens < 51200 ? fauxToolCall("new_context", {}) : fauxToolCall("inspect_fixture", {}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				if (inputTokens < 51200) {
					expect(context.messages.map(getMessageText).join("\n")).toContain(
						"Workflow Snapshot is task-control authority",
					);
				}
				return fauxAssistantMessage("Done");
			},
		]);
		await harness.session.prompt("Inspect fixture twice");
		expect(
			harness.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
		).toEqual([]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("context_window_warning")).toHaveLength(inputTokens < 51200 ? 1 : 0);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(2);
	});

	it("rejects obsolete handoff parameters before cutting", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" } },
			initialActiveToolNames: ["new_context"],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: "Obsolete model-authored summary" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				expect(result).toMatchObject({ isError: true });
				return fauxAssistantMessage("Obsolete argument rejected.");
			},
		]);
		await harness.session.prompt("Original task");
		expect(harness.eventsOfType("context_window_end")).toHaveLength(0);
	});

	it("does not enqueue a memory reminder after a terminal provider failure", async () => {
		const harness = await createHarness({
			models: [{ id: "test", contextWindow: 64000, maxTokens: 4000 }],
			settings: { contextManagement: { mode: "windowed", reserveTokens: 16000 }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		const failure = fauxAssistantMessage("", { stopReason: "error" });
		failure.errorMessage = "Request limit reached";
		failure.usage.input = 40000;
		harness.setResponses([failure]);
		await harness.session.prompt(`Inspect fixture ${"x".repeat(160000)}`);
		expect(harness.eventsOfType("context_window_warning")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
	});

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
		expect(secondProviderMessages[0]?.text).toContain("Workflow Snapshot is task-control authority");
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
