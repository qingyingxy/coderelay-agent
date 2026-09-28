import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { HistorySearchResult } from "../../../src/core/history.ts";
import type { WorkerExecutionContract } from "../../../src/core/subagents/worker-context.ts";
import { main } from "../../../src/main.ts";
import { subagentHandoff } from "../../workflow/subagent-fixtures.ts";
import { createHarness, getMessageText } from "../harness.ts";

const harness = await createHarness({ models: [{ id: "fast" }] });
let contract: WorkerExecutionContract;
let fixedSystemPrompt: string;
const handoff = subagentHandoff({
	conclusion: "Worker finished",
	changedFiles: ["result.txt"],
	verificationSummary: ["node verify.cjs: passed"],
});
const unverified = process.env.PI_WORKER_TEST_UNVERIFIED === "1";
harness.setResponses([
	(context, _options, _state, model) => {
		assert.equal(model.id, "fast");
		fixedSystemPrompt = context.systemPrompt ?? "";
		const line = fixedSystemPrompt
			.split("\n")
			.find((line) => line.startsWith("Parent execution contract (fixed for this Attempt): "));
		assert.ok(line);
		contract = JSON.parse(
			line.slice("Parent execution contract (fixed for this Attempt): ".length),
		) as WorkerExecutionContract;
		assert.equal(contract.verificationCommands[0], "node verify.cjs");
		return fauxAssistantMessage(fauxToolCall("read", { path: "evidence.txt" }), { stopReason: "toolUse" });
	},
	fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "fixed" }), { stopReason: "toolUse" }),
	fauxAssistantMessage(
		fauxToolCall("notes", {
			action: "upsert",
			category: "discovery",
			title: "Fixture compatibility constraint",
			content: "Keep the original fixture behavior; tests not yet run.",
		}),
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
	(context, _options, _state, model) => {
		assert.equal(model.id, "fast");
		assert.equal(context.systemPrompt, fixedSystemPrompt);
		const text = context.messages.map(getMessageText).join("\n");
		assert.match(text, /Observed modification: path="result.txt" operation=write/);
		assert.match(text, /Runtime context-window receipt: completedCuts=1;/);
		assert.match(text, /Fixture compatibility constraint/);
		assert.doesNotMatch(text, /Keep the original fixture behavior; tests not yet run/);
		return fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" });
	},
	(context, _options, _state, model) => {
		assert.equal(model.id, "fast");
		assert.equal(context.systemPrompt, fixedSystemPrompt);
		assert.ok(context.systemPrompt?.includes(contract.attemptId));
		const text = context.messages.map(getMessageText).join("\n");
		assert.match(text, /Observed modification: path="result.txt" operation=write/);
		assert.match(text, /Runtime context-window receipt: completedCuts=2;/);
		assert.ok(!text.includes("evidence-secret-741"));
		return fauxAssistantMessage(
			fauxToolCall("history", { action: "search", query: "evidence-secret-741", tool: "read", role: "toolResult" }),
			{ stopReason: "toolUse" },
		);
	},
	(context) => {
		const result = JSON.parse(getMessageText(context.messages.at(-1))) as HistorySearchResult;
		assert.equal(result.action, "search");
		assert.equal(result.matches.length, 1);
		return fauxAssistantMessage(
			fauxToolCall("history", { action: "read", entry_ids: [result.matches[0]!.entryId] }),
			{ stopReason: "toolUse" },
		);
	},
	(context) => {
		assert.match(getMessageText(context.messages.at(-1)), /evidence-secret-741/);
		return unverified
			? fauxAssistantMessage(handoff)
			: fauxAssistantMessage(fauxToolCall("bash", { command: "node verify.cjs" }), { stopReason: "toolUse" });
	},
	fauxAssistantMessage(handoff),
	fauxAssistantMessage(handoff),
	fauxAssistantMessage(handoff),
]);

await main(["--offline", "--no-extensions", "--no-skills", "--no-context-files", ...process.argv.slice(2)], {
	extensionFactories: [
		(pi) => {
			const model = harness.getModel();
			pi.registerProvider(model.provider, {
				api: harness.faux.api,
				apiKey: "faux-key",
				baseUrl: model.baseUrl,
				models: harness.models.map((model) => ({ ...model })),
			});
			pi.on("session_shutdown", () => harness.cleanup());
		},
	],
});
