import { describe, expect, it } from "vitest";
import {
	DIRECT_PLAN_UPGRADE_SEQUENCE,
	DirectPlanUpgradeError,
	decideDirectPlanUpgrade,
	validateDirectPlanUpgradeReadiness,
} from "../../src/core/workflow/direct-plan-upgrade.ts";
import { ModeAdviceError } from "../../src/core/workflow/mode-advisor.ts";
import { validateWorkflowTransition } from "../../src/core/workflow/transitions.ts";
import { NOW } from "./fixtures.ts";

describe("Direct to Plan upgrade", () => {
	it("continues a newly discovered bounded medium task in Direct", () => {
		expect(
			decideDirectPlanUpgrade(
				{
					complexity: "medium",
					riskLevel: "low",
					confidence: "high",
					reason: "The change remains localized",
				},
				NOW,
			),
		).toEqual({
			action: "continue_direct",
			advice: {
				complexity: "medium",
				riskLevel: "low",
				confidence: "high",
				reason: "The change remains localized",
				taskLevel: "medium",
				suggestedMode: "direct",
			},
			evaluatedAt: NOW,
		});
	});

	it("uses the same conservative policy as initial automatic mode advice", () => {
		expect(
			decideDirectPlanUpgrade(
				{
					complexity: "high",
					riskLevel: "high",
					confidence: "low",
					reason: "The discovered change crosses security and storage boundaries",
				},
				NOW,
			),
		).toEqual({
			action: "upgrade_to_plan",
			advice: {
				complexity: "high",
				riskLevel: "high",
				confidence: "low",
				reason: "The discovered change crosses security and storage boundaries",
				taskLevel: "high_risk",
				suggestedMode: "plan",
			},
			evaluatedAt: NOW,
			triggers: ["complexity", "risk", "confidence"],
			requiredSequence: DIRECT_PLAN_UPGRADE_SEQUENCE,
		});
	});

	it("requires persisted intent, a closed write boundary, and a draft Plan", () => {
		expect(
			validateDirectPlanUpgradeReadiness({
				upgradeRequestPersisted: true,
				writeAdmissionClosed: true,
				activeWriterStopped: true,
				draftPlanCreated: true,
			}),
		).toEqual([]);
		expect(
			validateDirectPlanUpgradeReadiness({
				upgradeRequestPersisted: false,
				writeAdmissionClosed: false,
				activeWriterStopped: false,
				draftPlanCreated: false,
			}).map(({ code }) => code),
		).toEqual([
			"direct_plan_upgrade.request_not_persisted",
			"direct_plan_upgrade.write_admission_open",
			"direct_plan_upgrade.writer_active",
			"direct_plan_upgrade.plan_missing",
		]);
	});

	it("guards the executing to planning state transition", () => {
		expect(
			validateWorkflowTransition("executing", "planning", {
				directPlanUpgradeRequested: true,
				writeOperationsStopped: true,
				draftPlanCreated: true,
			}),
		).toEqual([]);
		expect(validateWorkflowTransition("executing", "planning").map(({ code }) => code)).toEqual([
			"workflow.direct_plan_upgrade_required",
			"workflow.write_operations_active",
			"workflow.draft_plan_required",
		]);
	});

	it("rejects malformed assessments and timestamps", () => {
		expect(() =>
			decideDirectPlanUpgrade(
				{
					complexity: "extreme" as "high",
					riskLevel: "low",
					confidence: "high",
					reason: "Invalid complexity",
				},
				NOW,
			),
		).toThrow(ModeAdviceError);
		expect(() =>
			decideDirectPlanUpgrade(
				{
					complexity: "low",
					riskLevel: "low",
					confidence: "high",
					reason: "Valid assessment",
				},
				"invalid",
			),
		).toThrow(DirectPlanUpgradeError);
	});
});
