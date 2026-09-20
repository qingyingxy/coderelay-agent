import { createHash } from "node:crypto";
import type { ReadonlySessionManager } from "../session-manager.ts";

export const HANDOFF_ARCHIVE_PREFIX = "[Archived handoff]";

export interface HandoffArchiveReference {
	readonly entryId: string;
	readonly bytes: number;
	readonly sha256: string;
}

/** Reuse original, persisted tool calls; never silently truncate or promote them to verified facts. */
export function prepareHandoffArchive(
	manager: ReadonlySessionManager,
	toolCallId: string,
	handoff: string,
): { brief: string; references: HandoffArchiveReference[] } | undefined {
	const branch = manager.getBranch();
	const rejectedIds: string[] = [];
	for (const entry of [...branch].reverse()) {
		if (entry.type === "context_window" || (entry.type === "message" && entry.message.role === "user")) break;
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		if (message.toolName !== "new_context") continue;
		if (!message.isError) break;
		try {
			const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			const error: unknown = JSON.parse(text);
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "handoff_too_large") break;
			rejectedIds.unshift(message.toolCallId);
		} catch {
			break;
		}
		if (rejectedIds.length === 2) break;
	}
	if (rejectedIds.length < 2) return undefined;
	const references: HandoffArchiveReference[] = [];
	for (const id of [...rejectedIds, toolCallId]) {
		const source = branch.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) => part.type === "toolCall" && part.id === id && part.name === "new_context",
				),
		);
		if (!source || source.type !== "message" || source.message.role !== "assistant") return undefined;
		const call = source.message.content.find((part) => part.type === "toolCall" && part.id === id);
		if (!call || call.type !== "toolCall" || typeof call.arguments.handoff !== "string") return undefined;
		if (id === toolCallId && call.arguments.handoff !== handoff) return undefined;
		// Check the same public retrieval path used by the next window, including suppression rules.
		const readable = manager.queryHistory({ action: "read", entryIds: [source.id] }, 2048);
		if (readable.action !== "read" || !readable.entries.some((entry) => entry.entryId === source.id))
			return undefined;
		references.push({
			entryId: source.id,
			bytes: Buffer.byteLength(call.arguments.handoff, "utf8"),
			sha256: createHash("sha256").update(call.arguments.handoff, "utf8").digest("hex"),
		});
	}
	// A batch of duplicate calls is not two separate opportunities to correct the handoff.
	if (new Set(references.map((reference) => reference.entryId)).size !== 3) return undefined;
	return {
		references,
		brief: `${HANDOFF_ARCHIVE_PREFIX} Full unverified handoff versions remain in History, oldest to newest. Before continuing work or claiming completion, read history(action="read", entry_ids=${JSON.stringify(references.map((reference) => reference.entryId))}); follow nextCursor until complete. Recover unresolved work, constraints and next action from all versions; newer omissions do not resolve older requirements. These are agent reports, not verification evidence. No handoff text was truncated.`,
	};
}
