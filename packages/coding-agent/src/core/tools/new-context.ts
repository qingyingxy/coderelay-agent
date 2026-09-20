import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { MAX_HANDOFF_BYTES, TARGET_HANDOFF_BYTES, validateContextHandoff } from "../workflow/context-handoff.ts";
import { type HandoffArchiveReference, prepareHandoffArchive } from "../workflow/handoff-archive.ts";

const newContextSchema = Type.Object(
	{
		handoff: Type.Optional(
			Type.String({
				description: `Direct Workflow only: nonempty current task brief, at most ${MAX_HANDOFF_BYTES} UTF-8 bytes, not characters. Aim for about ${TARGET_HANDOFF_BYTES} UTF-8 bytes. Put modified-but-unverified work, unchecked regressions and next action first; then list verified checks with evidence references. Replaces the previous task brief; does not mark verification passed. Carry forward every unresolved item from the previous brief unless you cite evidence covering that item or a user instruction removing it. Passing the existing suite is not evidence for untested requirements; when unsure, keep the item unverified. If rejected for size, rewrite to the smaller target in the error and retry; a rejected call has not requested a cut. After two size rejections in this user turn, a third oversized handoff can use a short History index when all three full versions are retrievable; read that index before continuing work.`,
			}),
		),
	},
	{ additionalProperties: false },
);

export function createNewContextToolDefinition(
	request: (handoff?: string) => Promise<void>,
): ToolDefinition<typeof newContextSchema, { archivedHandoffs: HandoffArchiveReference[] } | undefined> {
	return defineTool({
		name: "new_context",
		label: "New Context",
		description:
			"Request a hard context-window cut after the current assistant response and tool batch finish. In an active Direct Workflow, pass a short handoff to persist current progress in its Snapshot. Otherwise omit handoff.",
		promptSnippet: "Request a fresh context window after completing the current tool batch",
		promptGuidelines: [
			"Before cutting, save any new or changed durable details not already preserved, using Notes when available. No Notes write is required when existing records suffice. Keep routine execution and verification state in the Workflow Snapshot; keep detailed background in Notes rather than duplicating it in the handoff. Preserve unresolved handoff items as required by the handoff schema.",
		],
		executionMode: "sequential",
		parameters: newContextSchema,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			let handoff = params.handoff;
			let archivedHandoffs: HandoffArchiveReference[] | undefined;
			if (params.handoff !== undefined) {
				const error = validateContextHandoff(params.handoff);
				if (error) {
					const archive =
						error.code === "handoff_too_large"
							? prepareHandoffArchive(ctx.sessionManager, toolCallId, params.handoff)
							: undefined;
					if (!archive) throw new Error(JSON.stringify(error));
					const archiveError = validateContextHandoff(archive.brief);
					if (archiveError) throw new Error(JSON.stringify(archiveError));
					handoff = archive.brief;
					archivedHandoffs = archive.references;
				}
			}
			await request(handoff?.trim());
			return {
				content: [
					{
						type: "text",
						text: `${archivedHandoffs ? "Archive fallback: full handoff versions retained in History; a short retrieval index replaces the direct brief. " : ""}Context-window cut accepted, pending completion of the current tool cycle. Do not request another cut for this boundary. Acceptance is not proof that the new window has started.`,
					},
				],
				details: archivedHandoffs ? { archivedHandoffs } : undefined,
			};
		},
	});
}
