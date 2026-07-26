import { describe, expect, it } from "vitest";
import type { DomainViolation } from "../../src/core/workflow/index.ts";
import {
	isAttemptTerminalStatus,
	isTaskTerminalStatus,
	isWorkflowTerminalStatus,
	validateAttemptTransition,
	validateRevisionTransition,
	validateTaskTransition,
	validateWorkflowTransition,
} from "../../src/core/workflow/index.ts";

function codes(violations: readonly DomainViolation[]): string[] {
	return violations.map((entry) => entry.code);
}

describe("workflow transitions", () => {
	it("accepts the Direct entry path only when its mode and root task are ready", () => {
		expect(
			validateWorkflowTransition("received", "executing", {
				directModeSelected: true,
				rootTaskExists: true,
			}),
		).toEqual([]);

		expect(codes(validateWorkflowTransition("received", "executing"))).toEqual([
			"workflow.direct_mode_required",
			"workflow.root_task_required",
		]);
	});

	it("requires missing information before clarifying and completion before leaving it", () => {
		expect(validateWorkflowTransition("received", "clarifying", { clarificationRequired: true })).toEqual([]);
		expect(codes(validateWorkflowTransition("received", "clarifying"))).toContain(
			"workflow.clarification_not_required",
		);
		expect(
			codes(
				validateWorkflowTransition("clarifying", "executing", {
					directModeSelected: true,
					rootTaskExists: true,
				}),
			),
		).toContain("workflow.clarification_incomplete");
	});

	it("enforces plan generation, read-only planning, approval, and task graph readiness", () => {
		expect(
			validateWorkflowTransition("planning", "awaiting_approval", {
				planReady: true,
				planReadOnly: true,
			}),
		).toEqual([]);
		expect(codes(validateWorkflowTransition("planning", "awaiting_approval"))).toEqual([
			"workflow.plan_required",
			"workflow.plan_write_detected",
		]);
		expect(
			validateWorkflowTransition("awaiting_approval", "executing", {
				planApproved: true,
				taskGraphReady: true,
			}),
		).toEqual([]);
	});

	it("requires a replacement plan when revising an awaiting plan", () => {
		expect(
			validateWorkflowTransition("awaiting_approval", "planning", {
				replacementPlanCreated: true,
			}),
		).toEqual([]);
		expect(codes(validateWorkflowTransition("awaiting_approval", "planning"))).toEqual([
			"workflow.replacement_plan_required",
		]);
	});

	it("stops Direct writes and creates a draft before upgrading to Plan", () => {
		expect(
			validateWorkflowTransition("executing", "planning", {
				directPlanUpgradeRequested: true,
				writeOperationsStopped: true,
				draftPlanCreated: true,
			}),
		).toEqual([]);
		expect(codes(validateWorkflowTransition("executing", "planning"))).toEqual([
			"workflow.direct_plan_upgrade_required",
			"workflow.write_operations_active",
			"workflow.draft_plan_required",
		]);
	});

	it("resumes a blocked workflow only to its recorded state", () => {
		expect(
			validateWorkflowTransition("blocked", "executing", {
				blockResolved: true,
				blockedResumeStatus: "executing",
			}),
		).toEqual([]);
		expect(
			codes(
				validateWorkflowTransition("blocked", "verifying", {
					blockResolved: true,
					blockedResumeStatus: "executing",
				}),
			),
		).toContain("workflow.invalid_resume_status");
	});

	it("allows an explicit replan to override a blocked resume state", () => {
		expect(
			validateWorkflowTransition("blocked", "planning", {
				replanningRequested: true,
				replacementPlanCreated: true,
				blockedResumeStatus: "executing",
			}),
		).toEqual([]);
	});

	it("enforces verification and completion gates", () => {
		expect(
			validateWorkflowTransition("executing", "verifying", {
				allRequiredTasksSucceeded: true,
			}),
		).toEqual([]);
		expect(
			validateWorkflowTransition("verifying", "completed", {
				completionGatePassed: true,
			}),
		).toEqual([]);
		expect(codes(validateWorkflowTransition("verifying", "completed"))).toEqual(["workflow.completion_gate_failed"]);
	});

	it("requires persisted cancellation and completed cleanup", () => {
		expect(
			validateWorkflowTransition("executing", "cancelling", {
				cancellationRequested: true,
			}),
		).toEqual([]);
		expect(codes(validateWorkflowTransition("executing", "cancelling"))).toEqual([
			"workflow.cancel_request_required",
		]);
		expect(
			validateWorkflowTransition("cancelling", "cancelled", {
				runtimeResourcesStopped: true,
				writerLeaseReleased: true,
			}),
		).toEqual([]);
	});

	it("requires terminal failure facts and runtime cleanup", () => {
		expect(
			validateWorkflowTransition("executing", "failed", {
				failureTerminalCondition: true,
				runtimeResourcesStopped: true,
			}),
		).toEqual([]);
		expect(codes(validateWorkflowTransition("executing", "failed"))).toEqual([
			"workflow.failure_not_terminal",
			"workflow.runtime_resources_active",
		]);
	});

	it("rejects transitions out of terminal states", () => {
		expect(codes(validateWorkflowTransition("completed", "executing"))).toEqual(["workflow.invalid_transition"]);
	});
});

describe("task transitions", () => {
	it("makes a pending task ready only in an executing workflow with satisfied dependencies", () => {
		expect(
			validateTaskTransition("pending", "ready", {
				workflowExecuting: true,
				dependenciesSucceeded: true,
			}),
		).toEqual([]);
		expect(codes(validateTaskTransition("pending", "ready"))).toEqual([
			"task.workflow_not_executing",
			"task.dependencies_incomplete",
		]);
	});

	it("requires an attempt and, for write tasks, a writer lease", () => {
		expect(
			validateTaskTransition("ready", "running", {
				attemptCreated: true,
				writerLeaseRequired: true,
				writerLeaseHeld: true,
			}),
		).toEqual([]);
		expect(
			codes(
				validateTaskTransition("ready", "running", {
					attemptCreated: true,
					writerLeaseRequired: true,
				}),
			),
		).toContain("task.writer_lease_required");
		expect(
			codes(
				validateTaskTransition("ready", "running", {
					attemptCreated: true,
					controlTask: true,
				}),
			),
		).toContain("task.control_not_executable");
	});

	it("routes tasks with required verification through verifying", () => {
		expect(
			validateTaskTransition("running", "verifying", {
				attemptSucceeded: true,
				hasRequiredVerification: true,
			}),
		).toEqual([]);
		expect(
			codes(
				validateTaskTransition("running", "succeeded", {
					attemptSucceeded: true,
					taskResultPresent: true,
					hasRequiredVerification: true,
				}),
			),
		).toContain("task.verification_required");
		expect(
			validateTaskTransition("verifying", "succeeded", {
				attemptSucceeded: true,
				taskResultPresent: true,
				requiredVerificationPassed: true,
			}),
		).toEqual([]);
	});

	it("requires retry permission before returning to ready", () => {
		const readyFacts = {
			workflowExecuting: true,
			dependenciesSucceeded: true,
		};
		expect(codes(validateTaskTransition("running", "ready", readyFacts))).toContain("task.retry_not_allowed");
		expect(validateTaskTransition("running", "ready", { ...readyFacts, retryAllowed: true })).toEqual([]);
	});

	it("requires resolution before leaving blocked", () => {
		expect(
			validateTaskTransition("blocked", "pending", {
				blockResolved: true,
			}),
		).toEqual([]);
		expect(codes(validateTaskTransition("blocked", "pending"))).toEqual(["task.block_not_resolved"]);
	});

	it("requires a terminal cause and a stopped attempt before failure", () => {
		expect(
			validateTaskTransition("running", "failed", {
				failureTerminalCondition: true,
				activeAttemptStopped: true,
			}),
		).toEqual([]);
		expect(codes(validateTaskTransition("running", "failed"))).toEqual([
			"task.failure_not_terminal",
			"task.attempt_active",
		]);
	});
});

describe("attempt transitions", () => {
	it("accepts lifecycle transitions and rejects terminal rewrites", () => {
		expect(validateAttemptTransition("queued", "running")).toEqual([]);
		expect(validateAttemptTransition("running", "waiting")).toEqual([]);
		expect(validateAttemptTransition("waiting", "succeeded")).toEqual([]);
		expect(codes(validateAttemptTransition("succeeded", "running"))).toEqual(["attempt.invalid_transition"]);
	});
});

describe("terminal status helpers", () => {
	it("identify only true terminal statuses", () => {
		expect(isWorkflowTerminalStatus("completed")).toBe(true);
		expect(isWorkflowTerminalStatus("blocked")).toBe(false);
		expect(isTaskTerminalStatus("skipped")).toBe(true);
		expect(isTaskTerminalStatus("verifying")).toBe(false);
		expect(isAttemptTerminalStatus("timed_out")).toBe(true);
		expect(isAttemptTerminalStatus("waiting")).toBe(false);
	});
});

describe("revision transitions", () => {
	it("requires each accepted entity event to increment revision exactly once", () => {
		expect(validateRevisionTransition(0, 1)).toEqual([]);
		expect(codes(validateRevisionTransition(2, 4))).toEqual(["revision.invalid_next"]);
		expect(codes(validateRevisionTransition(-1, 0))).toEqual(["revision.invalid_current"]);
	});
});
