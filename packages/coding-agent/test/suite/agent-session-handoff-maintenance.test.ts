import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { runHandoffMaintenance } from "../../evals/context-window/handoff-maintenance.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const originalHandoff = readFileSync(new URL("../fixtures/context-handoff/patent-2120.txt", import.meta.url), "utf8");
const oversizedHandoff = originalHandoff.repeat(2);
const correctedHandoff =
	"未完成：专利交底书正文、图示及DOCX核验。下一步：从History核对原始要求与数据，完成草稿；未验证事项不得标为通过。";

describe("Direct handoff validation and bounded maintenance", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("accepts the original 2120-byte handoff unchanged on the first response", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: originalHandoff }), { stopReason: "toolUse" }),
		]);
		expect(await runHandoffMaintenance(harness.session)).toMatchObject({
			completed: true,
			requests: 1,
			corrections: 0,
			toolErrors: 0,
			cuts: 1,
		});
		const boundary = harness.sessionManager.getBranch().find((entry) => entry.type === "context_window");
		expect(boundary?.type === "context_window" && boundary.contextSeed.content).toContain(originalHandoff);
	});

	it("corrects a 4240-byte handoff without cutting on rejection", async () => {
		expect(Buffer.byteLength(originalHandoff, "utf8")).toBe(2120);
		expect(createHash("sha256").update(originalHandoff).digest("hex")).toBe(
			"6251d08b2368545e4ee69593cac8cf63570e5f7d6bf608625f88ba08f40a0770",
		);
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		const phases: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && !event.isError)
				phases.push(harness.session.contextWindowRuntimeState.phase);
			if (event.type === "context_window_end") phases.push(harness.session.contextWindowRuntimeState.phase);
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: oversizedHandoff }), { stopReason: "toolUse" }),
			(context) => {
				expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_window")).toHaveLength(
					0,
				);
				expect(harness.session.contextWindowRuntimeState.phase).toBe("idle");
				const rejected = context.messages.find((message) => message.role === "toolResult");
				expect(rejected).toMatchObject({ isError: true });
				expect(JSON.parse(getMessageText(rejected))).toMatchObject({
					code: "handoff_too_large",
					actualBytes: 4240,
					maxBytes: 4000,
					retryable: true,
				});
				expect(
					JSON.stringify(harness.sessionManager.getBranch().filter((entry) => entry.type === "custom")),
				).not.toContain(oversizedHandoff);
				return fauxAssistantMessage(fauxToolCall("new_context", { handoff: correctedHandoff }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("must not call provider after successful cut"),
		]);
		const result = await runHandoffMaintenance(harness.session);
		expect(result).toMatchObject({
			completed: true,
			requests: 2,
			corrections: 1,
			toolCalls: 2,
			toolErrors: 1,
			cuts: 1,
		});
		expect(harness.getPendingResponseCount()).toBe(1);
		const boundary = harness.sessionManager.getBranch().find((entry) => entry.type === "context_window");
		expect(boundary?.type === "context_window" && boundary.contextSeed.content).toContain(correctedHandoff);
		expect(harness.eventsOfType("context_window_requested")).toHaveLength(1);
		expect(phases).toEqual(["cut_pending", "idle"]);
	});

	it.each([
		["ascii boundary", "a".repeat(4000), true],
		["ascii overflow", "a".repeat(4001), false],
		["Chinese and ASCII boundary", `${"中".repeat(1333)}a`, true],
		["Chinese overflow", "中".repeat(1334), false],
		["four-byte boundary", "𠮷".repeat(1000), true],
		["four-byte overflow", `${"𠮷".repeat(1000)}a`, false],
		["empty", "", false],
		["whitespace", " \n\t ", false],
	] as const)("validates %s through the actual tool", async (_name, handoff, accepted) => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { handoff }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Ready"),
		]);
		await harness.session.prompt("Preserve historical requirements", {
			isolatedDirectExecution: { reason: "Offline handoff boundary regression" },
		});
		expect(harness.eventsOfType("context_window_end")).toHaveLength(accepted ? 1 : 0);
		const result = harness.eventsOfType("tool_execution_end")[0];
		expect(result.isError).toBe(!accepted);
		if (accepted) {
			const boundary = harness.sessionManager.getBranch().find((entry) => entry.type === "context_window");
			expect(boundary?.type === "context_window" && boundary.contextSeed.content).toContain(handoff);
		}
		if (!accepted)
			expect(JSON.parse(getMessageText(result.result))).toMatchObject({
				actualBytes: Buffer.byteLength(handoff, "utf8"),
				retryable: true,
			});
	});

	it.each(["Ready", "oversized"])("stops after three provider responses for repeated %s", async (scenario) => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		const previousStream = harness.session.agent.streamFunction;
		const previousTools = harness.session.getActiveToolNames();
		harness.setResponses(
			Array.from({ length: 4 }, () =>
				scenario === "Ready"
					? fauxAssistantMessage("Ready")
					: fauxAssistantMessage(fauxToolCall("new_context", { handoff: oversizedHandoff }), {
							stopReason: "toolUse",
						}),
			),
		);
		const result = await runHandoffMaintenance(harness.session);
		expect(result).toMatchObject({
			completed: scenario === "oversized",
			requests: 3,
			corrections: 2,
			cuts: scenario === "oversized" ? 1 : 0,
		});
		expect(result.noCutReplies).toBe(scenario === "Ready" ? 3 : 0);
		if (scenario === "Ready") expect(result.error).toContain("budget exhausted");
		else expect(result.archiveFallbacks).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.agent.streamFunction).toBe(previousStream);
		expect(harness.session.getActiveToolNames()).toEqual(previousTools);
	});

	it("uses the last correction after oversized text followed by Ready", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: oversizedHandoff }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Ready"),
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: correctedHandoff }), { stopReason: "toolUse" }),
		]);
		expect(await runHandoffMaintenance(harness.session)).toMatchObject({
			completed: true,
			requests: 3,
			corrections: 2,
			noCutReplies: 1,
			cuts: 1,
		});
	});

	it("does not retry provider errors", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" }),
			fauxAssistantMessage("unused"),
		]);
		expect(await runHandoffMaintenance(harness.session)).toMatchObject({ completed: false, requests: 1, cuts: 0 });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("coalesces duplicate pending requests into one persisted cut", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("new_context", { handoff: correctedHandoff }), fauxToolCall("new_context", {})],
				{ stopReason: "toolUse" },
			),
		]);
		expect(await runHandoffMaintenance(harness.session)).toMatchObject({ completed: true, requests: 1, cuts: 1 });
		expect(harness.eventsOfType("context_window_requested")).toHaveLength(1);
	});

	it("stops on a non-argument tool failure without spending correction requests", async () => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		// A second handoff while a cut is pending is not a length error.
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("new_context", { handoff: correctedHandoff }),
					fauxToolCall("new_context", { handoff: correctedHandoff }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("unused"),
		]);
		const result = await runHandoffMaintenance(harness.session);
		expect(result).toMatchObject({ completed: false, requests: 1, toolErrors: 1, cuts: 1 });
		expect(result.error).toContain("Non-correctable tool failure");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("aborts an in-flight response at the shared maintenance deadline", async () => {
		const harness = await createHarness({
			settings: { contextManagement: { mode: "windowed" }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([
			async (_context, options) => {
				const signal = options?.signal;
				if (!signal) throw new Error("Missing abort signal");
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Deadline" });
			},
			fauxAssistantMessage("unused"),
		]);
		expect(await runHandoffMaintenance(harness.session, { timeoutMs: 100 })).toMatchObject({
			completed: false,
			requests: 1,
			cuts: 0,
			error: "Maintenance deadline exceeded",
		});
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
