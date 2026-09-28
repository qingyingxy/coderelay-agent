import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";

const newContextSchema = Type.Object({}, { additionalProperties: false });

export function createNewContextToolDefinition(
	request: () => Promise<void>,
): ToolDefinition<typeof newContextSchema, undefined> {
	return defineTool({
		name: "new_context",
		label: "New Context",
		description: "Request a hard context-window cut after the current assistant response and tool batch finish.",
		promptSnippet: "Request a fresh context window after completing the current tool batch",
		promptGuidelines: [
			"Before cutting, save only new or changed durable semantics not already preserved, using Notes when available. No Notes write is required when existing records suffice. Routine execution and verification state is checkpointed deterministically in the Workflow Snapshot.",
		],
		executionMode: "sequential",
		parameters: newContextSchema,
		execute: async () => {
			await request();
			return {
				content: [
					{
						type: "text",
						text: "Context-window cut accepted, pending completion of the current tool cycle. Do not request another cut for this boundary. Acceptance is not proof that the new window has started.",
					},
				],
				details: undefined,
			};
		},
	});
}
