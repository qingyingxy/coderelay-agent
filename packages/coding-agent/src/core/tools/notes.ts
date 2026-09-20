import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { MEMORY_NOTE_WRITING_GUIDELINES } from "../memory-note-writing-policy.ts";
import { MEMORY_REVISION_GUIDELINE, MEMORY_TARGETED_SEARCH_GUIDELINE } from "../memory-retrieval-policy.ts";
import {
	MEMORY_NOTE_CATEGORIES,
	type MemoryNoteChangeResult,
	type MemoryNoteIndex,
	type MemoryNoteReadRequest,
	type MemoryNoteReadResult,
	type MemoryNotesListResult,
	type MemoryNotesQuery,
	type MemoryNoteUpsertInput,
	memoryNoteIndex,
} from "../notes.ts";

export const MEMORY_QUESTION_COVERAGE_GUIDELINE =
	"Answer each requested definition, condition, quantity or mechanism directly for the requested time scope. Do not substitute a related quantity or allocation rule for a definition. Include adjacent details only when needed to explain the answer; when quantity is asked, give the supported quantity. Base historical user decisions on user messages or Notes recording them, not implementation reports alone. Retrieve only missing evidence, mark unsupported points unknown, and stop when the question is answered. Follow the requested format without exposing an internal checklist.";

const notesSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("search"),
			Type.Literal("read"),
			Type.Literal("upsert"),
			Type.Literal("archive"),
		]),
		title: Type.Optional(
			Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
				description:
					"Upsert title: topic plus current decision or revision, in one line of at most 160 UTF-8 bytes. Null uses a content preview; null for other actions.",
			}),
		),
		keywords: Type.Optional(
			Type.Union([Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 }), Type.Null()], {
				description:
					"Upsert literal search aliases in the user's language plus useful technical terms; each at most 80 UTF-8 bytes. Null when unused.",
			}),
		),
		query: Type.Optional(
			Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
				description: "Required for search: case-insensitive literal substring. Null for other actions.",
			}),
		),
		cursor: Type.Optional(
			Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
				description:
					"Use null on the FIRST list/search/read call. For continuation copy the exact returned nextCursor; keep filters unchanged. Never invent a placeholder.",
			}),
		),
		note_id: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()], {
				description:
					"Required for read/archive; reuse the existing stable topic ID for upsert revisions, null for a new topic. Null for list/search.",
			}),
		),
		category: Type.Optional(
			Type.Union([...MEMORY_NOTE_CATEGORIES.map((category) => Type.Literal(category)), Type.Null()], {
				description:
					"Required for upsert. Optional list/search filter: null means all categories. Null for read/archive.",
			}),
		),
		content: Type.Optional(
			Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
				description: "Required full body for upsert; null for other actions.",
			}),
		),
		workflow_id: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()], {
				description: "Upsert association or list/search filter. Null when absent; never use a placeholder.",
			}),
		),
		task_id: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()], {
				description: "Upsert association or list/search filter. Null when absent; never use a placeholder.",
			}),
		),
		source_entry_ids: Type.Optional(
			Type.Union([Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 50 }), Type.Null()], {
				description: "Upsert source IDs from the current branch. Null when unused.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type NotesToolResult =
	| MemoryNotesListResult
	| MemoryNoteReadResult
	| {
			readonly schemaVersion: 1;
			readonly action: "upsert" | "archive";
			readonly note: MemoryNoteIndex;
	  };

export interface NotesToolDetails {
	readonly result: NotesToolResult;
}

export interface NotesToolController {
	list(request: MemoryNotesQuery): MemoryNotesListResult;
	read(request: MemoryNoteReadRequest): MemoryNoteReadResult;
	upsert(input: MemoryNoteUpsertInput): MemoryNoteChangeResult;
	archive(noteId: string): MemoryNoteChangeResult;
}

export function createNotesToolDefinition(
	controller: NotesToolController,
): ToolDefinition<typeof notesSchema, NotesToolDetails> {
	return defineTool({
		name: "notes",
		label: "Notes",
		description:
			"Store durable non-authoritative notes (body limit 32768 UTF-8 bytes). List/search return recent-first indexes; read returns body, version entryId, and sources. Follow nextCursor only when more content is needed; truncated content is not a complete record. Queries cover active notes on the current branch, including notes omitted from the context hint. Upsert replaces a note by stable note_id; archive hides it without erasing history. Workflow status remains in the Workflow Snapshot.",
		promptSnippet: "Maintain durable non-authoritative notes across context windows",
		promptGuidelines: [
			"Use cursor=null for the first list/search/read call, and null for unused fields or absent filters. Never fill optional fields with x, placeholder, current, or invented IDs. For subsequent pages, copy the exact returned nextCursor.",
			"Before requesting a new context, save new or changed durable decisions, constraints, discoveries and unresolved questions that are not already preserved. If nothing needs saving, cut without a Notes write. Never use notes as the source of truth for Workflow status or duplicate routine progress from the Snapshot.",
			...MEMORY_NOTE_WRITING_GUIDELINES,
			"Use current visible information and authoritative Workflow state first. Retrieve only missing information. The hint is a recent index, not note bodies or all memory: read a relevant note before relying on its contents; search/list notes only when the index does not locate it. Do not reread unchanged content already visible.",
			MEMORY_QUESTION_COVERAGE_GUIDELINE,
			MEMORY_REVISION_GUIDELINE,
			MEMORY_TARGETED_SEARCH_GUIDELINE,
			"Stop retrieval when required details are complete, no relevant conflict remains, and evidence precision meets the request. Notes alone may support an ordinary factual answer. Query History for missing details, conflicts, or required original quotations; prefer known original message Entry IDs over search. Search with alternate keywords when IDs are unavailable or insufficient. Do not infer completeness or absence from a truncated result, present Notes as original quotations, or guess missing facts.",
		],
		executionMode: "sequential",
		parameters: notesSchema,
		execute: async (_toolCallId, params) => {
			let result: NotesToolResult;
			if (params.action === "list" || params.action === "search") {
				if (params.action === "search" && !params.query?.trim()) throw new Error("notes search requires query");
				result = controller.list({
					query: params.action === "search" ? (params.query ?? undefined) : undefined,
					cursor: params.cursor ?? undefined,
					category: params.category ?? undefined,
					workflowId: params.workflow_id ?? undefined,
					taskId: params.task_id ?? undefined,
				});
			} else if (params.action === "read") {
				if (!params.note_id) throw new Error("notes read requires note_id");
				result = controller.read({ noteId: params.note_id, cursor: params.cursor ?? undefined });
			} else if (params.action === "upsert") {
				if (!params.category || !params.content) {
					throw new Error("notes upsert requires category and content");
				}
				const changed = controller.upsert({
					noteId: params.note_id ?? undefined,
					category: params.category,
					content: params.content,
					title: params.title ?? undefined,
					keywords: params.keywords ?? undefined,
					workflowId: params.workflow_id ?? undefined,
					taskId: params.task_id ?? undefined,
					sourceEntryIds: params.source_entry_ids ?? undefined,
				});
				result = { ...changed, note: memoryNoteIndex(changed.note) };
			} else {
				if (!params.note_id) throw new Error("notes archive requires note_id");
				const changed = controller.archive(params.note_id);
				result = { ...changed, note: memoryNoteIndex(changed.note) };
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { result },
			};
		},
	});
}
