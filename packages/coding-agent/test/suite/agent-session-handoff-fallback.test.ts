import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { runHandoffMaintenance } from "../../evals/context-window/handoff-maintenance.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { prepareHandoffArchive } from "../../src/core/workflow/handoff-archive.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const cases = JSON.parse(
	readFileSync(new URL("../fixtures/context-handoff/failures-4000.json", import.meta.url), "utf8"),
) as { dataset: string; handoffs: string[]; bytes: number[]; sha256: string[] }[];

describe("recorded handoff failure chains", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each(cases)("replays $dataset with explicit correction headroom", async (recorded) => {
		const harness = await createHarness({ settings: { contextManagement: { mode: "windowed" } } });
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		expect(recorded.handoffs.map((s) => Buffer.byteLength(s, "utf8"))).toEqual(recorded.bytes);
		expect(recorded.handoffs.map((s) => createHash("sha256").update(s).digest("hex"))).toEqual(recorded.sha256);
		harness.setResponses(
			recorded.handoffs.map((handoff) =>
				fauxAssistantMessage(fauxToolCall("new_context", { handoff }), { stopReason: "toolUse" }),
			),
		);
		expect(await runHandoffMaintenance(harness.session)).toMatchObject({
			completed: true,
			requests: 3,
			corrections: 2,
			cuts: 1,
			archiveFallbacks: 1,
		});
		for (const event of harness.eventsOfType("tool_execution_end").filter((event) => event.isError)) {
			const error = JSON.parse(getMessageText(event.result));
			expect(error).toMatchObject({ code: "handoff_too_large", maxBytes: 4000, targetBytes: 2400 });
			expect(error.message).toContain("Do not merely delete a few characters");
		}
		const result = harness.eventsOfType("tool_execution_end").at(-1)!;
		expect(result.isError).toBe(false);
		expect(getMessageText(result.result)).toContain("Archive fallback");
		const boundary = harness.sessionManager.getBranch().find((entry) => entry.type === "context_window");
		if (boundary?.type !== "context_window") throw new Error("Missing cut");
		expect(boundary.contextSeed.content).toContain("[Archived handoff]");
		expect(boundary.contextSeed.content).not.toContain(recorded.handoffs[2]);

		// Recreate a persisted session with the same original calls, then reopen it.
		const disk = SessionManager.create(harness.tempDir, join(harness.tempDir, "archive"));
		let lastCallId = "";
		for (const entry of harness.sessionManager.getBranch()) {
			if (
				entry.type === "message" &&
				(entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")
			) {
				if (entry.message.role === "toolResult" && !entry.message.isError) break;
				disk.appendMessage(entry.message);
				if (entry.message.role === "assistant") {
					for (const part of entry.message.content) if (part.type === "toolCall") lastCallId = part.id;
				}
			}
		}
		const reopened = SessionManager.open(disk.getSessionFile()!);
		const archived = prepareHandoffArchive(reopened, lastCallId, recorded.handoffs[2]);
		expect(archived?.references.map((ref) => ref.sha256)).toEqual(recorded.sha256);
		expect(Buffer.byteLength(archived!.brief, "utf8")).toBeLessThan(4000);
		for (const [index, reference] of archived!.references.entries()) {
			let cursor: string | undefined;
			let content = "";
			let pages = 0;
			do {
				const page = reopened.queryHistory({ action: "read", entryIds: [reference.entryId], cursor }, 2048);
				if (page.action !== "read") throw new Error("Expected history read");
				content += page.entries.map((entry) => entry.content).join("");
				cursor = page.nextCursor;
				pages++;
				expect(pages).toBeLessThan(20);
			} while (cursor);
			expect(pages).toBeGreaterThan(1);
			expect(JSON.parse(content.slice(content.indexOf("\n") + 1)).handoff).toBe(recorded.handoffs[index]);
		}
		// The actual next-window History tool resolves the index, not just the storage helper.
		const source = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.at(-1)!;
		harness.session.setActiveToolsByName(["history"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("history", { action: "read", entry_ids: [source.id] }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const read = context.messages.filter((message) => message.role === "toolResult").at(-1);
				const page = JSON.parse(getMessageText(read));
				expect(page.entries[0].entryId).toBe(source.id);
				const content = page.entries[0].content as string;
				expect(JSON.parse(content.slice(content.indexOf("\n") + 1)).handoff).toBe(recorded.handoffs[2]);
				return fauxAssistantMessage("Original handoff recovered");
			},
		]);
		await harness.session.prompt("Read the archived handoff before continuing", {
			isolatedDirectExecution: { reason: "Offline archive retrieval regression" },
		});
	});

	it.each(["missing-source", "new-user", "non-size-error", "unreadable-source", "same-batch"] as const)(
		"does not use an unsafe archive fallback: %s",
		(scenario) => {
			const manager = SessionManager.inMemory();
			const handoff = cases[0].handoffs[0];
			for (let i = 0; i < 3; i++) {
				if (scenario === "new-user" && i === 2)
					manager.appendMessage({ role: "user", content: "New request", timestamp: 1 });
				if (!(scenario === "missing-source" && i === 2) && !(scenario === "same-batch" && i > 0)) {
					const calls =
						scenario === "same-batch"
							? [0, 1, 2].map((n) => ({ ...fauxToolCall("new_context", { handoff }), id: `call-${n}` }))
							: [{ ...fauxToolCall("new_context", { handoff }), id: `call-${i}` }];
					manager.appendMessage(
						Object.assign(
							fauxAssistantMessage(calls, { stopReason: "toolUse" }),
							scenario === "unreadable-source" ? { excludeFromHistory: true } : {},
						),
					);
				}
				if (i < 2)
					manager.appendMessage({
						role: "toolResult",
						toolCallId: `call-${i}`,
						toolName: "new_context",
						isError: true,
						timestamp: 1,
						content: [
							{
								type: "text",
								text: JSON.stringify({
									code: scenario === "non-size-error" ? "handoff_empty" : "handoff_too_large",
								}),
							},
						],
					});
			}
			expect(prepareHandoffArchive(manager, "call-2", handoff)).toBeUndefined();
		},
	);
});
