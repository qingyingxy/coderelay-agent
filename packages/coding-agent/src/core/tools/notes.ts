import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import {
	MEMORY_NOTE_CATEGORIES,
	type MemoryNoteCategory,
	type MemoryNoteChangeResult,
	type MemoryNotesListResult,
} from "../notes.ts";

const notesSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("list"), Type.Literal("upsert"), Type.Literal("archive")]),
		note_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		category: Type.Optional(Type.Union(MEMORY_NOTE_CATEGORIES.map((category) => Type.Literal(category)))),
		content: Type.Optional(Type.String({ minLength: 1 })),
		workflow_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		source_entry_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 50 })),
	},
	{ additionalProperties: false },
);

export type NotesToolResult = MemoryNotesListResult | MemoryNoteChangeResult;

export interface NotesToolDetails {
	readonly result: NotesToolResult;
}

export interface NotesToolController {
	list(): MemoryNotesListResult;
	upsert(input: {
		readonly noteId?: string;
		readonly category: MemoryNoteCategory;
		readonly content: string;
		readonly workflowId?: string;
		readonly taskId?: string;
		readonly sourceEntryIds?: readonly string[];
	}): MemoryNoteChangeResult;
	archive(noteId: string): MemoryNoteChangeResult;
}

export function createNotesToolDefinition(
	controller: NotesToolController,
): ToolDefinition<typeof notesSchema, NotesToolDetails> {
	return defineTool({
		name: "notes",
		label: "Notes",
		description:
			"List, upsert, or archive durable non-authoritative notes for decisions, discoveries, preferences, constraints, and open questions. Workflow, Task, Attempt, and Verification status must remain in the Workflow Snapshot.",
		promptSnippet: "Maintain durable non-authoritative notes across context windows",
		promptGuidelines: [
			"Before requesting a new context, save only durable non-authoritative details in notes; never use notes as the source of truth for Workflow status.",
		],
		executionMode: "sequential",
		parameters: notesSchema,
		execute: async (_toolCallId, params) => {
			let result: NotesToolResult;
			if (params.action === "list") {
				result = controller.list();
			} else if (params.action === "upsert") {
				if (!params.category || !params.content) {
					throw new Error("notes upsert requires category and content");
				}
				result = controller.upsert({
					noteId: params.note_id,
					category: params.category,
					content: params.content,
					workflowId: params.workflow_id,
					taskId: params.task_id,
					sourceEntryIds: params.source_entry_ids,
				});
			} else {
				if (!params.note_id) throw new Error("notes archive requires note_id");
				result = controller.archive(params.note_id);
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { result },
			};
		},
	});
}
