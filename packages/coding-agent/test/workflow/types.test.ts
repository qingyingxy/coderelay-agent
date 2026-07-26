import { describe, expect, expectTypeOf, it } from "vitest";
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
import {
	DEFAULT_EXECUTION_MODE,
	EXECUTION_MODES,
	isExecutionMode,
	isResolvedExecutionMode,
	RESOLVED_EXECUTION_MODES,
} from "../../src/core/workflow/index.ts";

describe("workflow domain types", () => {
	it("defines selectable and resolved execution modes", () => {
		expect(EXECUTION_MODES).toEqual(["auto", "direct", "plan"]);
		expect(RESOLVED_EXECUTION_MODES).toEqual(["direct", "plan"]);
		expect(DEFAULT_EXECUTION_MODE).toBe("auto");

		expect(["auto", "direct", "plan"].every(isExecutionMode)).toBe(true);
		expect(["direct", "plan"].every(isResolvedExecutionMode)).toBe(true);
		expect(isExecutionMode("invalid")).toBe(false);
		expect(isExecutionMode(null)).toBe(false);
		expect(isResolvedExecutionMode("auto")).toBe(false);
	});

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
