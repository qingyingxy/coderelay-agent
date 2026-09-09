import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";

const newContextSchema = Type.Object(
	{
		handoff: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 2000,
				description:
					"Direct Workflow only: current task brief, at most 2000 UTF-8 bytes. Put modified-but-unverified work, unchecked regressions and next action first; then list verified checks with evidence references. Replaces the previous task brief; does not mark verification passed. Carry forward every unresolved item from the previous brief unless you cite evidence covering that item or a user instruction removing it. Passing the existing suite is not evidence for untested requirements; when unsure, keep the item unverified.",
			}),
		),
	},
	{ additionalProperties: false },
);

export function createNewContextToolDefinition(
	request: (handoff?: string) => Promise<void>,
): ToolDefinition<typeof newContextSchema, undefined> {
	return defineTool({
		name: "new_context",
		label: "New Context",
		description:
			"Request a hard context-window cut after the current assistant response and tool batch finish. In an active Direct Workflow, pass a short handoff to persist current progress in its Snapshot. Otherwise omit handoff.",
		promptSnippet: "Request a fresh context window after completing the current tool batch",
		executionMode: "sequential",
		parameters: newContextSchema,
		execute: async (_toolCallId, params) => {
			if (
				params.handoff !== undefined &&
				(!params.handoff.trim() || Buffer.byteLength(params.handoff, "utf8") > 2000)
			) {
				throw new Error("handoff must contain 1-2000 UTF-8 bytes");
			}
			await request(params.handoff?.trim());
			return {
				content: [
					{
						type: "text",
						text: "Context-window cut accepted. The new window will start after the current tool cycle finishes.",
					},
				],
				details: undefined,
			};
		},
	});
}
