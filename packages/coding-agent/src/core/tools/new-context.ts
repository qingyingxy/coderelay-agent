import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";

const newContextSchema = Type.Object({}, { additionalProperties: false });

export function createNewContextToolDefinition(
	request: () => Promise<void>,
): ToolDefinition<typeof newContextSchema, undefined> {
	return defineTool({
		name: "new_context",
		label: "New Context",
		description:
			"Request a hard context-window cut after the current assistant response and tool batch finish. Takes no arguments.",
		promptSnippet: "Request a fresh context window after completing the current tool batch",
		executionMode: "sequential",
		parameters: newContextSchema,
		execute: async () => {
			await request();
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
