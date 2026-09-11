import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { main } from "../../../src/main.ts";
import { subagentHandoff } from "../../workflow/subagent-fixtures.ts";
import { createHarness, getMessageText } from "../harness.ts";

const harness = await createHarness({ models: [{ id: "strong" }] });
const handoff = subagentHandoff({ conclusion: "Read-only review finished", changedFiles: [] });
harness.setResponses([
	(context, _options, _state, model) => {
		assert.equal(model.id, "strong");
		assert.deepEqual(
			context.tools?.map((tool) => tool.name),
			["read"],
		);
		return fauxAssistantMessage(fauxToolCall("read", { path: "review-target.txt" }), { stopReason: "toolUse" });
	},
	(context, _options, _state, model) => {
		assert.equal(model.id, "strong");
		assert.match(getMessageText(context.messages.at(-1)), /review-evidence-741/);
		assert.deepEqual(
			context.tools?.map((tool) => tool.name),
			["read"],
		);
		return fauxAssistantMessage(handoff);
	},
	(context, _options, _state, model) => {
		assert.equal(model.id, "strong");
		assert.deepEqual(
			context.tools?.map((tool) => tool.name),
			["read"],
		);
		return fauxAssistantMessage(handoff);
	},
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
