import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { WORKFLOW_NETWORK_RETRY } from "../../src/core/workflow/network-policy.ts";
import { attachRequestDiagnostics } from "../../src/core/workflow/request-diagnostics.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness } from "./harness.ts";

describe("Workflow network policy", () => {
	it.each(["parent", "rpc-child"])("applies the same policy at the %s SDK entry", async (role) => {
		const harness = await createHarness();
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false, maxRetries: 9, provider: { maxRetries: 9 } },
		});
		if (role === "rpc-child") vi.stubEnv("PI_WORKFLOW_NETWORK_RETRY", "1");
		let dispose: (() => void) | undefined;
		try {
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				model: harness.getModel(),
				resourceLoader: createTestResourceLoader(),
				sessionManager: SessionManager.inMemory(harness.tempDir),
				settingsManager,
				...(role === "parent" ? { workflowNetworkRetry: true } : {}),
			});
			dispose = () => session.dispose();
			expect(settingsManager.getRetrySettings()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 2_000 });
			expect(settingsManager.getProviderRetrySettings().maxRetries).toBe(0);
			harness.setResponses([fauxAssistantMessage("done")]);
			await session.prompt("test");
			expect(session.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({ customType: "model_attempt_end" }),
			);
		} finally {
			dispose?.();
			vi.unstubAllEnvs();
			harness.cleanup();
		}
	});
	it("retains failed-attempt costs without repeating successful tools", async () => {
		let toolCalls = 0;
		const harness = await createHarness({
			settings: { retry: { ...WORKFLOW_NETWORK_RETRY, baseDelayMs: 1 } },
			tools: [
				{
					name: "read",
					label: "read",
					description: "Mock read",
					parameters: Type.Object({}),
					execute: async () => {
						toolCalls++;
						return { content: [{ type: "text", text: "source" }], details: {} };
					},
				},
			],
		});
		// Faux estimates usage itself; inject transport usage at the message boundary.
		const detachUsage = harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			if (event.message.errorMessage === "Request timed out.") {
				event.message.usage = {
					input: 10,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				};
			} else if (event.message.errorMessage === "fetch failed") {
				event.message.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
		});
		const detach = attachRequestDiagnostics(harness.session);
		try {
			const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" }),
				failed,
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("implement");
			expect(toolCalls).toBe(1);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
			expect(harness.session.getSessionStats().cost).toBeGreaterThanOrEqual(0.25);
			const records = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "model_attempt_end");
			expect(records).toHaveLength(4);
			expect(records[2]).toMatchObject({ data: { usageKnown: false, retryAttempt: 1 } });
		} finally {
			detachUsage();
			detach();
			harness.cleanup();
		}
	});
	it.each(["Request timed out.", "invalid_api_key", "insufficient_quota", "Request aborted"])(
		"bounds retries for %s",
		async (errorMessage) => {
			const harness = await createHarness({ settings: { retry: { ...WORKFLOW_NETWORK_RETRY, baseDelayMs: 1 } } });
			try {
				harness.setResponses(
					Array.from({ length: 3 }, () =>
						fauxAssistantMessage("", {
							stopReason: errorMessage === "Request aborted" ? "aborted" : "error",
							errorMessage,
						}),
					),
				);
				await harness.session.prompt("test");
				expect(harness.faux.state.callCount).toBe(errorMessage === "Request timed out." ? 3 : 1);
			} finally {
				harness.cleanup();
			}
		},
	);
});
