import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export function thinkingAudit(path: string, stage: string) {
	return (pi: ExtensionAPI) => {
		let startedAt = 0;
		let headersAt: number | null = null;
		pi.on("message_start", event => {
			if (event.message.role !== "assistant") return;
			startedAt = Date.now();
			headersAt = null;
		});
		pi.on("after_provider_response", () => { headersAt = Date.now(); });
		pi.on("message_end", event => {
			if (event.message.role !== "assistant") return;
			const message = event.message;
			const usage = message.usage;
			const endedAt = Date.now();
			appendFileSync(`${path}.requests.jsonl`, `${JSON.stringify({ stage, startedAt, headersAt, endedAt,
				durationMs: endedAt - startedAt, stopReason: message.stopReason,
				usageKnown: usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0,
				recordedCost: usage.cost.total })}\n`);
		});
		pi.on("before_provider_request", event => {
			const payload = event.payload as { model?: string; reasoning?: { effort?: string } };
			appendFileSync(path, `${JSON.stringify({ stage, model: payload.model, sessionThinking: pi.getThinkingLevel(), requestEffort: payload.reasoning?.effort })}\n`);
		});
	};
}

export default function audit(pi: ExtensionAPI) {
	const path = process.env.PI_MATRIX_THINKING_AUDIT;
	if (!path) throw new Error("Missing host-owned thinking audit path");
	thinkingAudit(path, process.env.PI_MATRIX_STAGE ?? "child")(pi);
}
