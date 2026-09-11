import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { DeliveryRuntime } from "../../src/core/delivery/delivery-runtime.ts";
import { DiffCollector } from "../../src/core/delivery/diff-collector.ts";
import { SubagentReadonlyReviewer } from "../../src/core/delivery/reviewer-runtime.ts";
import { JobRuntime } from "../../src/core/jobs/job-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { InProcessSubagentSessionFactory } from "../../src/core/subagents/in-process-session.ts";
import { SubagentRuntime } from "../../src/core/subagents/subagent-runtime.ts";
import { CurrentWorkspaceProvider } from "../../src/core/subagents/workspace-provider.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import { WorkflowRuntimeRegistry } from "../../src/core/workflow/runtime-registry.ts";
import { WriterLeaseRegistry } from "../../src/core/workflow/writer-lease.ts";
import { subagentHandoff } from "../workflow/subagent-fixtures.ts";
import { createHarness, type Harness } from "./harness.ts";

it.each([true, false])(
	"runs one repair, retests and re-reviews with one slot (repair succeeds=%s)",
	async (repairSucceeds) => {
		const owner = await createHarness();
		const children: Harness[] = [];
		const source = join(owner.tempDir, "result.txt");
		const check = join(owner.tempDir, "verify.cjs");
		writeFileSync(source, "original");
		writeFileSync(
			check,
			'const fs = require("node:fs"); const ok = fs.readFileSync("result.txt", "utf8") === "fixed"; console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1);',
		);
		const trace: string[] = [];
		let workers = 0;
		let reviews = 0;
		const leases = new WriterLeaseRegistry();
		const factory = new InProcessSubagentSessionFactory(async (config) => {
			const child = await createHarness({
				initialActiveToolNames: config.profile.role === "worker" ? ["write"] : [],
				allowedToolNames: config.profile.role === "worker" ? ["write"] : [],
			});
			children.push(child);
			if (config.profile.role === "worker") {
				const stage = ++workers === 1 ? "execute" : "repair";
				trace.push(stage);
				child.setResponses([
					fauxAssistantMessage(
						fauxToolCall("write", {
							path: source,
							content: stage === "repair" && repairSucceeds ? "fixed" : stage,
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(subagentHandoff({ changedFiles: ["result.txt"] })),
				]);
			} else {
				trace.push(++reviews === 1 ? "review" : "re-review");
				expect(config.effectivePermissions.write).toBe(false);
				expect(leases.get(owner.tempDir)).toBeUndefined();
				const failed = readFileSync(source, "utf8") !== "fixed";
				const suggestion = {
					category: "suggestion",
					basis: "hardening",
					summary: "Optional cleanup",
					evidence: ["result.txt:1 cleanup"],
					introducedByChange: true,
					requirementId: null,
					requirementQuote: null,
				};
				const findings = [
					suggestion,
					...(failed
						? [
								{
									...suggestion,
									category: "must_fix",
									basis: "requirement",
									summary: "Result is not fixed",
									requirementId: "$request",
									requirementQuote: "Write fixed",
								},
							]
						: []),
				];
				child.setResponses([
					(_context) => {
						expect(JSON.stringify(_context.messages)).toContain(failed ? "FAIL" : "PASS");
						return fauxAssistantMessage(
							subagentHandoff({
								verificationSummary: [
									failed ? "review:failed" : "review:passed",
									`review_findings:${JSON.stringify(findings)}`,
								],
							}),
						);
					},
				]);
			}
			return child.session;
		});
		const agents = new SubagentRuntime({
			sessionFactory: factory,
			maxAgents: 1,
			writerLeaseRegistry: leases,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			workspaceProvider: new CurrentWorkspaceProvider(),
		});
		const jobs = new JobRuntime({
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			processFactory: {
				start(input) {
					expect(input.command).toBe("verify");
					trace.push("test");
					const child = spawn(process.execPath, [check], { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"] });
					child.stdout.on("data", (data: Buffer) => input.onStdout(data.toString()));
					child.stderr.on("data", (data: Buffer) => input.onStderr(data.toString()));
					const done = new Promise<{ exitCode: number | null }>((resolve, reject) => {
						child.on("error", reject);
						child.on("close", (exitCode) => resolve({ exitCode }));
					});
					return {
						pid: child.pid!,
						wait: () => done,
						async terminate() {
							child.kill();
							await done;
						},
					};
				},
			},
		});
		const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
			workflowId: "lifecycle",
			rootTaskId: "root",
			planId: "plan",
			budget: { maxRetries: 1, maxConcurrentAgents: 1 },
			request: { text: "Write fixed", cwd: owner.tempDir, attachments: [] },
		});
		plan.submit({
			goal: "Write fixed",
			assumptions: [],
			risks: [],
			steps: [
				{
					id: "implement",
					kind: "agent",
					requiredAgentRole: "worker",
					title: "Implement",
					description: "Write fixed",
					dependsOn: [],
					fileIntents: [{ path: "result.txt", action: "modify", reason: "Task output" }],
					verificationRequirementIds: ["diff"],
				},
			],
			verificationRequirements: [
				{ id: "diff", kind: "diff", description: "Output changed", required: true },
				{ id: "test", kind: "test", command: "verify", description: "Result is fixed", required: true },
				{ id: "review", kind: "review", description: "Scoped review", required: true },
			],
		});
		plan.approve();
		const collector = new DiffCollector();
		vi.spyOn(collector, "collect").mockImplementation(() => ({
			files: [],
			changedFiles: ["result.txt"],
			summary: readFileSync(source, "utf8"),
			evidenceRefs: [],
		}));
		const delivery = new DeliveryRuntime({
			jobRuntime: jobs,
			reviewer: new SubagentReadonlyReviewer(agents),
			diffCollector: collector,
			writerLeaseRegistry: leases,
		});
		try {
			const [execution] = await plan.startReadySubagents(agents, 1);
			await execution!.completion;
			await agents.release(execution!.agent.id);
			const first = await delivery.run(plan);
			expect(first.status).toBe("repair_created");
			expect(agents.availableSlots(plan.workflow.id)).toBe(1);
			const [repair] = await plan.startReadySubagents(agents, 1);
			await repair!.completion;
			await agents.release(repair!.agent.id);
			const final = await delivery.run(plan);
			expect(final.status).toBe(repairSucceeds ? "completed" : "failed");
			expect(plan.tasks.filter((task) => task.kind === "repair")).toHaveLength(1);
			expect(trace).toEqual(["execute", "test", "review", "repair", "test", "re-review"]);
			expect(agents.availableSlots(plan.workflow.id)).toBe(1);
			expect(leases.list()).toEqual([]);
			expect(agents.list().every((agent) => agent.sessionReleasedAt)).toBe(true);
			expect(workers).toBe(2);
		} finally {
			await agents.dispose();
			for (const child of children) child.cleanup();
			owner.cleanup();
		}
	},
	30_000,
);
