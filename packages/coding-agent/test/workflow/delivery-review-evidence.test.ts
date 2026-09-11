import { expect, it } from "vitest";
import { DeliveryRuntime } from "../../src/core/delivery/delivery-runtime.ts";
import type { ReadonlyReviewer } from "../../src/core/delivery/types.ts";
import { JobRuntime } from "../../src/core/jobs/job-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import { WorkflowRuntimeRegistry } from "../../src/core/workflow/runtime-registry.ts";
import { WriterLeaseRegistry } from "../../src/core/workflow/writer-lease.ts";

it.each([0, 1])("provides current command evidence before review (exit=%s)", async (exitCode) => {
	const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: "evidence-workflow",
		rootTaskId: "root",
		planId: "plan",
		budget: { maxRetries: 0 },
		request: { text: "Reject excessive decrements atomically", cwd: process.cwd(), attachments: [] },
	});
	plan.submit({
		goal: "Fix atomicity",
		assumptions: [],
		risks: [],
		steps: [
			{
				id: "implement",
				kind: "command",
				command: "implement",
				title: "Implement",
				description: "Implement",
				dependsOn: [],
				fileIntents: [],
				verificationRequirementIds: ["implementation"],
			},
		],
		verificationRequirements: [
			{ id: "implementation", kind: "manual", description: "Implementation completes", required: true },
			{ id: "review", kind: "review", description: "Scoped review", required: true },
			{ id: "tests", kind: "test", command: "verify", description: "Atomic rejection passes", required: true },
		],
	});
	plan.approve();
	const jobs = new JobRuntime({
		runtimeRegistry: new WorkflowRuntimeRegistry(),
		processFactory: {
			start(input) {
				return {
					pid: 12345,
					async terminate() {},
					async wait() {
						input.onStdout(input.command === "verify" ? `atomicity result ${exitCode}\n` : "implemented\n");
						return { exitCode: input.command === "verify" ? exitCode : 0 };
					},
				};
			},
		},
	});
	const [implementation] = await plan.startReadyJobs(jobs, 1);
	await implementation!.completion;
	plan.beginVerification();
	plan.recordVerification({
		verificationId: "stale",
		requirementId: "tests",
		deliveryFingerprint: "old-code",
		status: "passed",
		summary: "stale pass",
		command: "verify",
		exitCode: 0,
	});
	let observed: Parameters<ReadonlyReviewer["review"]>[0] | undefined;
	const delivery = new DeliveryRuntime({
		jobRuntime: jobs,
		writerLeaseRegistry: new WriterLeaseRegistry(),
		reviewer: {
			async review(input) {
				observed = input;
				return {
					status: "passed",
					summary: "Static review passed",
					evidenceRefs: [],
					risks: [],
					unfinishedItems: [],
				};
			},
		},
	});
	const result = await delivery.run(plan);
	expect(result.status).toBe(exitCode === 0 ? "completed" : "failed");
	expect(observed?.verificationEvidence).toHaveLength(1);
	expect(observed?.verificationEvidence?.[0]).toMatchObject({
		result: {
			requirementId: "tests",
			command: "verify",
			exitCode,
			status: exitCode === 0 ? "passed" : "failed",
			deliveryFingerprint: plan.deliveryFingerprint,
		},
		logExcerpt: `[stdout] atomicity result ${exitCode}\n`,
		logsTruncated: false,
	});
	expect(observed?.verificationEvidence?.[0]?.result.id).not.toBe("stale");
});
