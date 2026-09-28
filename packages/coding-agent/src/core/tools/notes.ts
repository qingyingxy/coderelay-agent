import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { MEMORY_NOTE_WRITING_GUIDELINES } from "../memory-note-writing-policy.ts";
import {
	MEMORY_REVISION_GUIDELINE,
	MEMORY_TARGETED_SEARCH_GUIDELINE,
	WORKFLOW_PROJECTION_RETRIEVAL_GUIDELINE,
	WORKFLOW_RECEIPT_RETRIEVAL_GUIDELINE,
} from "../memory-retrieval-policy.ts";
import {
	MEMORY_NOTE_CATEGORIES,
	type MemoryNoteChangeResult,
	type MemoryNoteIndex,
	type MemoryNoteReadRequest,
	type MemoryNoteReadResult,
	type MemoryNotesListResult,
	type MemoryNotesQuery,
	type MemoryNoteUpsertInput,
	MemoryNoteValidationError,
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
					"Required for upsert. open_question means an unresolved external decision or missing evidence whose answer can change future action; implementation progress, verification status, remaining work and next actions belong in Workflow. Optional list/search filter: null means all categories. Null for read/archive.",
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
			"Store durable non-authoritative notes (body limit 32768 UTF-8 bytes). New context windows receive only a short recent Notes index, never Note bodies. List/search return recent-first indexes; read returns a requested body, version entryId, and sources. Follow nextCursor only when more content is needed; truncated content is not a complete record. Upsert replaces a note by stable note_id while retaining prior source Entry IDs; archive hides it without erasing history. Workflow status remains in the Workflow Snapshot.",
		promptSnippet: "Maintain durable non-authoritative notes across context windows",
		promptGuidelines: [
			"Use cursor=null for the first list/search/read call, and null for unused fields or absent filters. Never fill optional fields with x, placeholder, current, or invented IDs. For subsequent pages, copy the exact returned nextCursor.",
			"Default to no Notes write when a turn only carries out behavior already preserved in Active Notes. Never create or revise open_question for verification not run, remaining files or stages, next action, implementation completion or readiness, test status, acceptance status, or another completed implementation stage; these are Workflow facts. Revise an open question only when its unresolved external choice or missing evidence changes or becomes resolved, or the user changes its priority.",
			"During normal work, upsert an Active Note in the turn when an important cross-window decision, constraint, discovery, actionable pending proposal or durable unresolved question becomes clear or changes. Preserve the proposal's approval status and intended behavior before finishing an analysis that later work may rely on; update the same note when the user approves, rejects or revises it. For a contract that must survive later Workflows, keep one compact stable-topic Note rather than one Note per stage. Do not wait for a context boundary or store routine execution progress.",
			"Before requesting a new context, save new or changed durable decisions, constraints, discoveries and qualifying open questions that are not already preserved. If nothing needs saving, cut without a Notes write. Never use notes as the source of truth for Workflow status or duplicate routine progress from the Snapshot.",
			...MEMORY_NOTE_WRITING_GUIDELINES,
			"Use current visible information, the Workflow Projection, and Workspace first. Do not read or search Notes merely because a new context started or an index item looks related. When the current request depends on an earlier Workflow, stage or user decision and its relevant semantics are absent from the current Projection, use the index to read the matching Note; do not guess the missing user contract from Workspace code or reread unchanged content already visible.",
			WORKFLOW_PROJECTION_RETRIEVAL_GUIDELINE,
			WORKFLOW_RECEIPT_RETRIEVAL_GUIDELINE,
			MEMORY_QUESTION_COVERAGE_GUIDELINE,
			MEMORY_REVISION_GUIDELINE,
			MEMORY_TARGETED_SEARCH_GUIDELINE,
			"Stop retrieval when required details are complete, no relevant conflict remains, and evidence precision meets the request. Notes alone may support an ordinary factual answer. Treat the current workspace as authoritative for current code, symbols, methods, files, configuration and repository state; inspect them with workspace read/search tools, never History. After reading a matching Note, query History only for still-missing exact user wording, unavailable prior tool results, conflicts or original evidence. Prefer known original message Entry IDs over search. Do not infer completeness or absence from a truncated result, present Notes as original quotations, or guess missing facts.",
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
				const content = params.content.trim();
				if (!content) throw new Error("notes upsert requires non-empty content");
				let cursor: string | undefined;
				do {
					const page = controller.list({ category: params.category, query: content, cursor });
					for (const candidate of page.notes) {
						if (
							candidate.noteId === params.note_id ||
							candidate.contentBytes !== Buffer.byteLength(content, "utf8")
						)
							continue;
						let body = "";
						let readCursor: string | undefined;
						let note: MemoryNoteReadResult["note"];
						do {
							const read = controller.read({ noteId: candidate.noteId, cursor: readCursor });
							note = read.note;
							body += read.note.content;
							readCursor = read.nextCursor;
						} while (readCursor);
						if (
							body === content &&
							note.workflowId === (params.workflow_id ?? undefined) &&
							note.taskId === (params.task_id ?? undefined)
						) {
							throw new Error(
								`notes upsert duplicates active note_id ${candidate.noteId}; reuse that note_id for the same decision, or write distinct scoped content for separate topics`,
							);
						}
					}
					cursor = page.nextCursor;
				} while (cursor);
				let previousSourceEntryIds: readonly string[] = [];
				let unknownNoteId = false;
				if (params.note_id) {
					try {
						previousSourceEntryIds = controller.read({ noteId: params.note_id }).note.sourceEntryIds;
					} catch (error) {
						if (
							!(error instanceof MemoryNoteValidationError) ||
							!error.message.includes(`active note ${params.note_id} does not exist`)
						)
							throw error;
						unknownNoteId = true;
					}
				}
				const requestedNoteId = params.note_id;
				if (
					unknownNoteId &&
					requestedNoteId &&
					/^[a-z0-9]{8}(?:-[a-z0-9]{4}){3}-[a-z0-9]{12}$/i.test(requestedNoteId)
				) {
					let indexCursor: string | undefined;
					do {
						const page = controller.list({ cursor: indexCursor });
						for (const candidate of page.notes) {
							if (
								candidate.noteId.length === requestedNoteId.length &&
								[...candidate.noteId].reduce(
									(differences, character, index) =>
										differences + Number(character !== requestedNoteId[index]),
									0,
								) <= 2
							) {
								throw new Error(
									`notes upsert note_id ${requestedNoteId} closely matches active note_id ${candidate.noteId}; use the existing ID to revise that decision, or null for a new topic`,
								);
							}
						}
						indexCursor = page.nextCursor;
					} while (indexCursor);
				}
				const sourceEntryIds = [...new Set([...previousSourceEntryIds, ...(params.source_entry_ids ?? [])])];
				if (sourceEntryIds.length > 50) throw new Error("notes upsert exceeds 50 retained source Entry IDs");
				const changed = controller.upsert({
					noteId: params.note_id ?? undefined,
					category: params.category,
					content,
					title: params.title ?? undefined,
					keywords: params.keywords ?? undefined,
					workflowId: params.workflow_id ?? undefined,
					taskId: params.task_id ?? undefined,
					sourceEntryIds,
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
