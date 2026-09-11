import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { main } from "../../../src/main.ts";
import { subagentHandoff } from "../../workflow/subagent-fixtures.ts";
import { createHarness } from "../harness.ts";

const harness = await createHarness({ models: [{ id: "strong" }] });
harness.setResponses([
	async (_context, options) => {
		if (existsSync(join(process.cwd(), "review-started"))) {
			return fauxAssistantMessage(subagentHandoff({ verificationSummary: ["review:passed", "review_findings:[]"] }));
		}
		writeFileSync(join(process.cwd(), "review-started"), "ready");
		await new Promise<void>((resolve) => {
			if (options?.signal?.aborted) resolve();
			else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return fauxAssistantMessage(subagentHandoff());
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
