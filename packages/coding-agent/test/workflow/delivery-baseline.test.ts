import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureDeliveryBaseline,
	captureScopedDeliveryBaseline,
	DELIVERY_BASELINE_ENTRY,
} from "../../src/core/delivery/baseline.ts";
import { DeliveryRuntime } from "../../src/core/delivery/delivery-runtime.ts";
import { DiffCollector } from "../../src/core/delivery/diff-collector.ts";
import type { ReadonlyReviewer } from "../../src/core/delivery/types.ts";
import { JobRuntime } from "../../src/core/jobs/job-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SubagentRuntime } from "../../src/core/subagents/subagent-runtime.ts";
import { createWorkflowAutomationPolicy } from "../../src/core/workflow/autonomous-workflow-policy.ts";
import { AutonomousWorkflowRunner } from "../../src/core/workflow/autonomous-workflow-runner.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import { WorkflowRuntimeRegistry } from "../../src/core/workflow/runtime-registry.ts";
import { WriterLeaseRegistry } from "../../src/core/workflow/writer-lease.ts";
import { spawnProcessSync } from "../../src/utils/child-process.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "./subagent-fixtures.ts";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(gitBase = false, scoped = false) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-delivery-baseline-"));
	directories.push(cwd);
	if (gitBase) {
		writeFileSync(join(cwd, "args.ts"), "committed\nbefore\n");
		for (const args of [
			["init"],
			["add", "args.ts"],
			["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"],
		]) {
			expect(spawnProcessSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).status).toBe(0);
		}
	}
	writeFileSync(join(cwd, "args.ts"), "user edit\nbefore\n");
	if (scoped) {
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src/router.ts"), "original router\n");
	}
	const session = SessionManager.create(cwd, join(cwd, "sessions"));
	session.appendMessage(fauxAssistantMessage("Plan"));
	const plan = PlanWorkflowRuntime.start(session, {
		request: { text: "Fix only args.ts", cwd, attachments: [] },
		budget: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentJobs: 1 },
	});
	plan.submit({
		goal: "Fix only args.ts",
		assumptions: [],
		risks: [],
		steps: [
			{
				id: "fix",
				kind: "agent",
				requiredAgentRole: "worker",
				title: "Fix",
				description: "Fix args.ts",
				dependsOn: [],
				fileIntents: [{ path: "args.ts", action: "modify", reason: "Fix" }],
				verificationRequirementIds: ["diff"],
			},
		],
		verificationRequirements: [
			{ id: "diff", kind: "diff", description: "Scoped change", required: true },
			{ id: "review", kind: "review", description: "Review", required: true },
		],
	});
	if (scoped) {
		session.appendCustomEntry(
			DELIVERY_BASELINE_ENTRY,
			captureScopedDeliveryBaseline(cwd, plan.workflow.id, ["args.ts", "src"]),
		);
	}
	plan.approve();
	const task = {
		...plan.tasks.find((task) => task.kind === "agent")!,
		modifications: [
			{
				path: "args.ts",
				operation: "edit" as const,
				workflowId: plan.workflow.id,
				taskId: "task",
				attemptId: "attempt",
				agentId: "agent",
				toolCallId: "edit",
				recordedAt: new Date().toISOString(),
			},
		],
	};
	return { cwd, session, plan, task };
}

describe("delivery baseline", () => {
	it("uses host source scope for unplanned edits and new files across recovery", () => {
		const { cwd, session, plan, task } = setup(false, true);
		writeFileSync(join(cwd, "src/router.ts"), "fixed router\n");
		writeFileSync(join(cwd, "src/new.ts"), "new module\n");
		writeFileSync(join(cwd, "outside.ts"), "not covered\n");
		const recovered = PlanWorkflowRuntime.recoverLatest(SessionManager.open(session.getSessionFile()!))!;
		expect(recovered.deliveryBaseline).toEqual(plan.deliveryBaseline);
		const tasks = ["src/router.ts", "src/new.ts", "outside.ts"].map((path) => ({
			...task,
			modifications: [{ ...task.modifications[0]!, path }],
		}));
		const diff = new DiffCollector().collect(cwd, tasks, recovered.deliveryBaseline);
		expect(diff.files[0]?.patch).toContain("-original router\n+fixed router");
		expect(diff.files[0]?.unavailableReason).toBeUndefined();
		expect(diff.files[1]?.patch).toContain("--- /dev/null");
		expect(diff.files[2]?.unavailableReason).toContain("No pre-execution baseline");
	});

	it("keeps unreadable files unknown even inside a fully enumerated directory", () => {
		const { cwd, plan, task } = setup(false, true);
		writeFileSync(join(cwd, "src/router.ts"), Buffer.from([0, 1, 2]));
		const baseline = captureScopedDeliveryBaseline(cwd, plan.workflow.id, ["src"]);
		writeFileSync(join(cwd, "src/router.ts"), "text replacement\n");
		const diff = new DiffCollector().collect(
			cwd,
			[{ ...task, modifications: [{ ...task.modifications[0]!, path: "src/router.ts" }] }],
			baseline,
		);
		expect(diff.files[0]?.unavailableReason).toContain("Binary");
		expect(diff.files[0]?.patch).toBe("");
		expect(() => captureScopedDeliveryBaseline(cwd, plan.workflow.id, ["../outside"])).toThrow(
			"Invalid baseline scope",
		);
	});

	it("persists the approved workspace through recovery instead of reading modified content", () => {
		const { cwd, session, plan, task } = setup();
		writeFileSync(join(cwd, "args.ts"), "user edit\nafter\n");
		const recovered = PlanWorkflowRuntime.recoverLatest(SessionManager.open(session.getSessionFile()!))!;
		expect(recovered.deliveryBaseline).toEqual(plan.deliveryBaseline);
		const diff = new DiffCollector().collect(cwd, [task], recovered.deliveryBaseline);
		expect(diff.files[0]?.patch).toContain("-before\n+after");
		expect(diff.files[0]?.patch).not.toContain("/dev/null");
		expect(diff.files[0]?.patch).not.toContain("+user edit");
	});

	it("uses the captured dirty workspace even when a Git baseline exists", () => {
		const { cwd, plan, task } = setup(true);
		writeFileSync(join(cwd, "args.ts"), "user edit\nafter\n");
		const diff = new DiffCollector().collect(cwd, [task], plan.deliveryBaseline);
		expect(diff.files[0]?.patch).toContain("-before\n+after");
		expect(diff.files[0]?.patch).not.toContain("+user edit");
		expect(diff.files[0]?.patch).not.toContain("-committed");
		expect(diff.files[0]?.unavailableReason).toBeUndefined();
	});

	it("distinguishes genuinely created, deleted, and unchanged files", () => {
		const { cwd, plan, task } = setup();
		const baseline = captureDeliveryBaseline(cwd, plan.workflow.id, ["args.ts", "new.ts"]);
		expect(new DiffCollector().collect(cwd, [task], baseline).files).toEqual([]);
		rmSync(join(cwd, "args.ts"));
		writeFileSync(join(cwd, "new.ts"), "created\n");
		const created = {
			...task,
			modifications: [{ ...task.modifications[0]!, path: "new.ts", operation: "write" as const }],
		};
		const diff = new DiffCollector().collect(cwd, [task, created], baseline);
		expect(diff.files[0]?.patch).toContain("+++ /dev/null");
		expect(diff.files[1]?.patch).toContain("--- /dev/null");
	});

	it("does not turn absent or unreadable evidence into a whole-file addition", () => {
		const { cwd, plan, task } = setup();
		const collector = new DiffCollector();
		expect(collector.collect(cwd, [task]).files[0]).toMatchObject({
			patch: "",
			unavailableReason: expect.any(String),
		});
		expect(
			collector.collect(cwd, [task], { ...plan.deliveryBaseline!, files: [] }).files[0]?.unavailableReason,
		).toContain("baseline");
		rmSync(join(cwd, "args.ts"));
		mkdirSync(join(cwd, "args.ts"));
		const baseline = captureDeliveryBaseline(cwd, plan.workflow.id, ["args.ts"]);
		expect(collector.collect(cwd, [task], baseline).files[0]).toMatchObject({
			patch: "",
			unavailableReason: expect.any(String),
		});
	});

	it("reports a failed Git diff instead of accepting empty output", () => {
		const { cwd, task } = setup();
		for (const args of [["init"], ["add", "args.ts"]]) {
			expect(spawnProcessSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).status).toBe(0);
		}
		const diff = new DiffCollector().collect(cwd, [task]);
		expect(diff.files[0]).toMatchObject({ patch: "", unavailableReason: "Git baseline diff failed" });
		expect(diff.evidenceRefs).toEqual([]);
	});

	it.each([false, true])(
		"automatically reviews the original baseline after execution and repair=%s",
		async (repair) => {
			const { cwd, plan } = setup();
			const factory = new FakeSubagentSessionFactory();
			const subagents = new SubagentRuntime({
				sessionFactory: factory,
				runtimeRegistry: new WorkflowRuntimeRegistry(),
				writerLeaseRegistry: new WriterLeaseRegistry(),
			});
			const jobs = new JobRuntime({ runtimeRegistry: new WorkflowRuntimeRegistry() });
			const review = vi.fn<ReadonlyReviewer["review"]>().mockImplementation(async ({ diff }) => {
				expect(diff.files[0]?.patch).toContain("-before");
				expect(diff.files[0]?.patch).not.toContain("/dev/null");
				const failed = repair && review.mock.calls.length === 1;
				return {
					status: failed ? "failed" : "passed",
					failureKind: failed ? "finding" : undefined,
					summary: failed ? "Fix remaining behavior" : "Passed",
					evidenceRefs: ["args.ts:2"],
					risks: [],
					unfinishedItems: [],
				};
			});
			const runner = new AutonomousWorkflowRunner({
				runtime: plan,
				subagentRuntime: subagents,
				jobRuntime: jobs,
				deliveryRuntime: new DeliveryRuntime({ jobRuntime: jobs, reviewer: { review } }),
				policy: createWorkflowAutomationPolicy("plan", { maxConcurrency: 1 }),
			});
			try {
				const pending = runner.pump();
				for (let index = 0; index < (repair ? 2 : 1); index++) {
					await vi.waitFor(() => expect(factory.sessions[index]?.promptCalls).toHaveLength(1));
					writeFileSync(join(cwd, "args.ts"), `user edit\nafter-${index}\n`);
					const child = factory.sessions[index]!;
					child.emit({
						type: "tool_execution_start",
						toolCallId: "edit",
						toolName: "edit",
						args: { path: "args.ts" },
					});
					child.emit({ type: "tool_execution_end", toolCallId: "edit", toolName: "edit", isError: false });
					child.complete(
						subagentHandoff({
							conclusion: "Fixed",
							changedFiles: ["args.ts"],
							verificationSummary: ["Change applied"],
						}),
					);
				}
				expect((await pending).status).toBe("completed");
				expect(review).toHaveBeenCalledTimes(repair ? 2 : 1);
			} finally {
				await subagents.dispose();
			}
		},
	);

	it("stops before review or repair when a changed path has no baseline", async () => {
		const { plan, task } = setup();
		const review = vi.fn<ReadonlyReviewer["review"]>();
		const failDelivery = vi.fn();
		const createRepair = vi.fn();
		const result = await new DeliveryRuntime({ jobRuntime: new JobRuntime(), reviewer: { review } }).run({
			workflow: plan.workflow,
			currentPlan: plan.currentPlan,
			tasks: [plan.tasks[0]!, task],
			verifications: [],
			deliveryBaseline: { ...plan.deliveryBaseline!, files: [] },
			beginVerification: vi.fn(),
			recordVerification: vi.fn(),
			failDelivery,
			createRepair,
			completeDelivery: vi.fn(),
		});
		expect(result.status).toBe("failed");
		expect(failDelivery).toHaveBeenCalledWith(expect.stringContaining("Delivery diff unavailable"));
		expect(review).not.toHaveBeenCalled();
		expect(createRepair).not.toHaveBeenCalled();
	});
});
