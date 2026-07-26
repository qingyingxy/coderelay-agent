import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type {
	DomainViolation,
	Plan,
	PlanContent,
	WorkflowEventBatch,
	WorkflowEventDraft,
} from "../../src/core/workflow/index.ts";
import {
	createWorkflowEventBatch,
	isPlanTerminalStatus,
	SessionWorkflowEventLog,
	validatePlan,
	validatePlanTransition,
	validateWorkflowEventBatch,
	WORKFLOW_SCHEMA_VERSION,
	WorkflowStore,
	WorkflowStoreError,
} from "../../src/core/workflow/index.ts";
import { createDirectStartBatch, NOW } from "./fixtures.ts";

function codes(violations: readonly DomainViolation[]): string[] {
	return violations.map(({ code }) => code);
}

function createDraftPlan(): Plan {
	return {
		schemaVersion: WORKFLOW_SCHEMA_VERSION,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
		id: "plan-1",
		workflowId: "workflow-1",
		version: 1,
		status: "draft",
		goal: "",
		assumptions: [],
		steps: [],
		risks: [],
		verificationRequirements: [],
	};
}

function createCompleteContent(): PlanContent {
	return {
		goal: "Add a formal Plan state machine",
		assumptions: ["The existing Workflow Event Log remains authoritative"],
		steps: [
			{
				id: "step-1",
				title: "Define Plan state",
				description: "Add the Plan entity, transitions, events, and Store projection",
				dependsOn: [],
				fileIntents: [
					{
						path: "packages/coding-agent/src/core/workflow/types.ts",
						action: "modify",
						reason: "Define the Plan entity",
					},
				],
				verificationRequirementIds: ["verify-plan"],
			},
		],
		risks: [
			{
				level: "low",
				description: "Persisted event compatibility",
				mitigation: "Keep the existing Workflow schema version and additive event types",
			},
		],
		verificationRequirements: [
			{
				id: "verify-plan",
				kind: "test",
				description: "Run Plan state tests",
				required: true,
			},
		],
	};
}

function createBatch(
	id: string,
	expectedLastSequence: number,
	events: readonly WorkflowEventDraft[],
): WorkflowEventBatch {
	return createWorkflowEventBatch({
		batchId: `${id}-batch`,
		workflowId: "workflow-1",
		commandId: `${id}-command`,
		correlationId: "plan-correlation",
		expectedLastSequence,
		events,
	});
}

function createPlanBatch(): WorkflowEventBatch {
	return createBatch("plan-create", 4, [
		{
			eventId: "plan-created",
			entityId: "plan-1",
			entityRevision: 0,
			eventType: "plan.created",
			occurredAt: NOW,
			actor: { kind: "controller" },
			payload: { plan: createDraftPlan() },
		},
		{
			eventId: "plan-selected",
			entityId: "workflow-1",
			entityRevision: 3,
			eventType: "workflow.plan_selected",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: "plan-created",
			payload: { planId: "plan-1" },
		},
	]);
}

function createPlanContentBatch(): WorkflowEventBatch {
	return createBatch("plan-content", 6, [
		{
			eventId: "plan-content-updated",
			entityId: "plan-1",
			entityRevision: 1,
			eventType: "plan.content_updated",
			occurredAt: NOW,
			actor: { kind: "agent", id: "planner" },
			payload: { content: createCompleteContent() },
		},
	]);
}

function createAwaitingApprovalBatch(): WorkflowEventBatch {
	return createBatch("plan-awaiting", 7, [
		{
			eventId: "plan-awaiting-approval",
			entityId: "plan-1",
			entityRevision: 2,
			eventType: "plan.awaiting_approval",
			occurredAt: NOW,
			actor: { kind: "controller" },
			payload: {
				fromStatus: "draft",
				toStatus: "awaiting_approval",
				facts: {
					structureValid: true,
					latestVersion: true,
					readOnly: true,
				},
			},
		},
	]);
}

function createApprovedBatch(): WorkflowEventBatch {
	return createBatch("plan-approved", 8, [
		{
			eventId: "plan-approved",
			entityId: "plan-1",
			entityRevision: 3,
			eventType: "plan.approved",
			occurredAt: NOW,
			actor: { kind: "user" },
			payload: {
				fromStatus: "awaiting_approval",
				toStatus: "approved",
				facts: {},
			},
		},
	]);
}

function createRejectedBatch(): WorkflowEventBatch {
	return createBatch("plan-rejected", 8, [
		{
			eventId: "plan-rejected",
			entityId: "plan-1",
			entityRevision: 3,
			eventType: "plan.rejected",
			occurredAt: NOW,
			actor: { kind: "user" },
			payload: {
				fromStatus: "awaiting_approval",
				toStatus: "rejected",
				facts: {},
			},
		},
	]);
}

function createReplacementBatch(): WorkflowEventBatch {
	const replacement: Plan = {
		...createDraftPlan(),
		id: "plan-2",
		version: 2,
		supersedesPlanId: "plan-1",
	};
	return createBatch("plan-replacement", 8, [
		{
			eventId: "replacement-plan-created",
			entityId: "plan-2",
			entityRevision: 0,
			eventType: "plan.created",
			occurredAt: NOW,
			actor: { kind: "controller" },
			payload: { plan: replacement },
		},
		{
			eventId: "previous-plan-superseded",
			entityId: "plan-1",
			entityRevision: 3,
			eventType: "plan.superseded",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: "replacement-plan-created",
			payload: {
				fromStatus: "awaiting_approval",
				toStatus: "superseded",
				facts: {
					replacementPlanCreated: true,
				},
				replacementPlanId: "plan-2",
			},
		},
		{
			eventId: "replacement-plan-selected",
			entityId: "workflow-1",
			entityRevision: 4,
			eventType: "workflow.plan_selected",
			occurredAt: NOW,
			actor: { kind: "controller" },
			causationId: "previous-plan-superseded",
			payload: { planId: "plan-2" },
		},
	]);
}

describe("Plan domain model", () => {
	it("allows an incomplete Draft but requires complete approval content", () => {
		expect(validatePlan(createDraftPlan())).toEqual([]);
		expect(
			codes(
				validatePlan({
					...createDraftPlan(),
					status: "awaiting_approval",
				}),
			),
		).toEqual(["plan.goal_required", "plan.steps_required", "plan.verification_required"]);
		expect(
			validatePlan({
				...createDraftPlan(),
				...createCompleteContent(),
				status: "awaiting_approval",
			}),
		).toEqual([]);
	});

	it("rejects duplicate, missing, and cyclic step relationships", () => {
		const content = createCompleteContent();
		const firstStep = content.steps[0];
		if (!firstStep) {
			throw new Error("Expected a Plan step");
		}
		const plan: Plan = {
			...createDraftPlan(),
			...content,
			steps: [
				{
					...firstStep,
					dependsOn: ["step-2"],
				},
				{
					...firstStep,
					id: "step-2",
					dependsOn: ["step-1"],
					verificationRequirementIds: ["missing-verification"],
				},
			],
		};

		expect(codes(validatePlan(plan))).toEqual(
			expect.arrayContaining(["plan.step_verification_missing", "plan.step_cycle"]),
		);
	});
});

describe("Plan state machine", () => {
	it("requires valid, latest, read-only content before approval", () => {
		expect(
			validatePlanTransition("draft", "awaiting_approval", {
				structureValid: true,
				latestVersion: true,
				readOnly: true,
			}),
		).toEqual([]);
		expect(codes(validatePlanTransition("draft", "awaiting_approval"))).toEqual([
			"plan.structure_invalid",
			"plan.latest_version_required",
			"plan.write_detected",
		]);
	});

	it("allows user decisions and prevents terminal rewrites", () => {
		expect(validatePlanTransition("awaiting_approval", "approved")).toEqual([]);
		expect(validatePlanTransition("awaiting_approval", "rejected")).toEqual([]);
		expect(codes(validatePlanTransition("approved", "draft"))).toEqual(["plan.invalid_transition"]);
		expect(isPlanTerminalStatus("approved")).toBe(true);
		expect(isPlanTerminalStatus("awaiting_approval")).toBe(false);
	});

	it("requires a replacement before superseding a Plan", () => {
		expect(
			validatePlanTransition("awaiting_approval", "superseded", {
				replacementPlanCreated: true,
			}),
		).toEqual([]);
		expect(codes(validatePlanTransition("awaiting_approval", "superseded"))).toEqual(["plan.replacement_required"]);
	});
});

describe("Plan events and Store", () => {
	it("validates Plan event envelopes and user-only decisions", () => {
		expect(validateWorkflowEventBatch(createPlanBatch())).toEqual([]);
		const approved = createApprovedBatch();
		const event = approved.events[0];
		if (!event || event.eventType !== "plan.approved") {
			throw new Error("Expected a Plan approved event");
		}
		const invalid = {
			...approved,
			events: [{ ...event, actor: { kind: "controller" as const } }],
		};

		expect(codes(validateWorkflowEventBatch(invalid))).toContain("event.user_actor_required");
	});

	it("persists and replays the complete Plan lifecycle", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const persisted = [
			eventLog.append(createDirectStartBatch()),
			eventLog.append(createPlanBatch()),
			eventLog.append(createPlanContentBatch()),
			eventLog.append(createAwaitingApprovalBatch()),
			eventLog.append(createApprovedBatch()),
		];
		const store = new WorkflowStore();
		const replayed = new WorkflowStore();
		store.replay(persisted);
		replayed.replay(eventLog.read());

		expect(store.getWorkflow("workflow-1")?.currentPlanId).toBe("plan-1");
		expect(store.getPlan("plan-1")).toMatchObject({
			revision: 3,
			version: 1,
			status: "approved",
			goal: "Add a formal Plan state machine",
		});
		expect(store.listPlans("workflow-1")).toHaveLength(1);
		expect(replayed.getPlan("plan-1")).toEqual(store.getPlan("plan-1"));
	});

	it("does not allow Plan content to change after leaving Draft", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const store = new WorkflowStore();
		store.replay([
			eventLog.append(createDirectStartBatch()),
			eventLog.append(createPlanBatch()),
			eventLog.append(createPlanContentBatch()),
			eventLog.append(createAwaitingApprovalBatch()),
			eventLog.append(createApprovedBatch()),
		]);
		const invalidUpdate = createBatch("plan-late-update", 9, [
			{
				eventId: "plan-late-content",
				entityId: "plan-1",
				entityRevision: 4,
				eventType: "plan.content_updated",
				occurredAt: NOW,
				actor: { kind: "agent", id: "planner" },
				payload: { content: createCompleteContent() },
			},
		]);

		expect(() => store.apply(eventLog.append(invalidUpdate))).toThrow(WorkflowStoreError);
		expect(store.getPlan("plan-1")?.revision).toBe(3);
	});

	it("persists a user rejection as an immutable terminal Plan state", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const store = new WorkflowStore();
		store.replay([
			eventLog.append(createDirectStartBatch()),
			eventLog.append(createPlanBatch()),
			eventLog.append(createPlanContentBatch()),
			eventLog.append(createAwaitingApprovalBatch()),
			eventLog.append(createRejectedBatch()),
		]);

		expect(store.getPlan("plan-1")?.status).toBe("rejected");
	});

	it("supersedes an awaiting Plan only after creating and selecting its replacement", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const store = new WorkflowStore();
		store.replay([
			eventLog.append(createDirectStartBatch()),
			eventLog.append(createPlanBatch()),
			eventLog.append(createPlanContentBatch()),
			eventLog.append(createAwaitingApprovalBatch()),
			eventLog.append(createReplacementBatch()),
		]);

		expect(store.getPlan("plan-1")?.status).toBe("superseded");
		expect(store.getPlan("plan-2")).toMatchObject({
			version: 2,
			status: "draft",
			supersedesPlanId: "plan-1",
		});
		expect(store.getWorkflow("workflow-1")?.currentPlanId).toBe("plan-2");
		expect(store.listPlans("workflow-1").map(({ id }) => id)).toEqual(["plan-1", "plan-2"]);
	});

	it("returns defensive Plan copies", () => {
		const session = SessionManager.inMemory();
		const eventLog = new SessionWorkflowEventLog(session);
		const store = new WorkflowStore();
		store.replay([
			eventLog.append(createDirectStartBatch()),
			eventLog.append(createPlanBatch()),
			eventLog.append(createPlanContentBatch()),
		]);
		const plan = store.getPlan("plan-1");
		if (!plan) {
			throw new Error("Expected a Plan");
		}
		(plan.assumptions as string[]).push("external mutation");

		expect(store.getPlan("plan-1")?.assumptions).toEqual(["The existing Workflow Event Log remains authoritative"]);
	});
});
