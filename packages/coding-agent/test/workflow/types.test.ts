import { describe, expectTypeOf, it } from "vitest";
import type {
	AttemptStatus,
	AttemptTerminalStatus,
	ExecutionMode,
	ResolvedExecutionMode,
	TaskStatus,
	TaskTerminalStatus,
	UserRequest,
	WorkflowResult,
	WorkflowStatus,
	WorkflowTerminalStatus,
} from "../../src/core/workflow/index.ts";

describe("workflow domain types", () => {
	it("keeps automatic mode unresolved and user requests explicitly resolvable", () => {
		expectTypeOf<ExecutionMode>().toEqualTypeOf<"auto" | "direct" | "plan">();
		expectTypeOf<ResolvedExecutionMode>().toEqualTypeOf<"direct" | "plan">();
		expectTypeOf<UserRequest["requestedMode"]>().toEqualTypeOf<ResolvedExecutionMode | undefined>();
	});

	it("keeps terminal Workflow statuses aligned with WorkflowResult", () => {
		expectTypeOf<WorkflowTerminalStatus>().toEqualTypeOf<"completed" | "failed" | "cancelled">();
		expectTypeOf<WorkflowTerminalStatus>().toMatchTypeOf<WorkflowStatus>();
		expectTypeOf<WorkflowResult["status"]>().toEqualTypeOf<WorkflowTerminalStatus>();
	});

	it("keeps Task and Attempt terminal statuses as subsets of their lifecycle states", () => {
		expectTypeOf<TaskTerminalStatus>().toEqualTypeOf<"succeeded" | "failed" | "cancelled" | "skipped">();
		expectTypeOf<TaskTerminalStatus>().toMatchTypeOf<TaskStatus>();
		expectTypeOf<AttemptTerminalStatus>().toEqualTypeOf<
			"succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted"
		>();
		expectTypeOf<AttemptTerminalStatus>().toMatchTypeOf<AttemptStatus>();
	});
});
