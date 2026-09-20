import { Type } from "typebox";
import { defineTool } from "../extensions/types.ts";
import type { MemoryReviewCoordinator } from "../workflow/memory-review.ts";

export function createMemoryReviewToolDefinition(coordinator: MemoryReviewCoordinator) {
	return defineTool({
		name: "memory_review",
		label: "Memory review",
		description:
			"Track host-created Workflow memory review tasks. Decisions belong in Notes, not here. Status returns pending scopes. Submit a full per-user-message review; use deferred when unsure. Saved revisions require real Note/source links. Unchanged requires a reason and does not require a Notes write. Completion validates coverage and references, not semantic truth.",
		parameters: Type.Object(
			{
				action: Type.Union([Type.Literal("status"), Type.Literal("submit")]),
				workflow_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				items: Type.Optional(
					Type.Union([
						Type.Array(
							Type.Object(
								{
									sourceEntryId: Type.String({ minLength: 1 }),
									outcome: Type.Union([
										Type.Literal("saved"),
										Type.Literal("unchanged"),
										Type.Literal("deferred"),
									]),
									noteIds: Type.Array(Type.String({ minLength: 1 })),
									reason: Type.String({ minLength: 1, maxLength: 1000 }),
								},
								{ additionalProperties: false },
							),
							{ maxItems: 1000 },
						),
						Type.Null(),
					]),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_id, params) => {
			if (params.action === "submit" && (!params.workflow_id || !params.items))
				throw new Error("submit requires workflow_id and items");
			const result =
				params.action === "status"
					? { pending: coordinator.pending() }
					: coordinator.submit(params.workflow_id!, params.items!);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
