import type { AgentSession } from "../agent-session.ts";

/** Keep failed attempts in the audit trail even when retry removes them from model context. */
export function attachRequestDiagnostics(session: AgentSession): () => void {
	let sequence = 0;
	let retryAttempt = 0;
	let startedAt = 0;
	return session.subscribe((event) => {
		if (event.type === "auto_retry_start") {
			retryAttempt = event.attempt;
			session.sessionManager.appendCustomEntry("network_retry", { ...event, recordedAt: Date.now() });
		} else if (event.type === "auto_retry_end") {
			retryAttempt = 0;
			session.sessionManager.appendCustomEntry("network_retry", { ...event, recordedAt: Date.now() });
		} else if (event.type === "message_start" && event.message.role === "assistant") {
			startedAt = Date.now();
			sequence++;
			session.sessionManager.appendCustomEntry("model_attempt_start", { sequence, retryAttempt, startedAt });
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const endedAt = Date.now();
			const usageKnown =
				message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0;
			const stop = session.sessionManager
				.getEntries()
				.slice()
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" &&
						["planner_stop", "host_stop"].includes(entry.customType) &&
						Date.parse(entry.timestamp) >= startedAt,
				);
			session.sessionManager.appendCustomEntry("model_attempt_end", {
				sequence,
				retryAttempt,
				startedAt,
				endedAt,
				durationMs: endedAt - startedAt,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				usageKnown,
				recordedCost: message.usage.cost.total,
				cancellationSource:
					message.stopReason === "aborted"
						? stop?.type === "custom"
							? stop.customType
							: "unknown_local_or_provider_abort"
						: null,
				// The normalized AssistantMessage does not retain the original transport exception.
				errorClass: null,
				causeCode: null,
			});
			if (message.stopReason !== "error") retryAttempt = 0;
		}
	});
}
