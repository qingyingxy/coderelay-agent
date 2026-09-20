import { describe, expect, it, vi } from "vitest";
import {
	BUILTIN_AGENT_PROFILES,
	FULL_PERMISSION_SET,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "./subagent-fixtures.ts";

describe("runtime-owned Worker verification", () => {
	it.each(["none", "edit", "bash", "unchanged", "resume"])(
		"runs only necessary acceptance checks (%s)",
		async (repair) => {
			const factory = new FakeSubagentSessionFactory();
			const failsInitially = repair !== "none" && repair !== "resume";
			const verify = vi.fn(async () => ({
				exitCode: failsInitially && verify.mock.calls.length === 1 ? 1 : 0,
				output: "focused assertion result",
				timedOut: false,
			}));
			const runtime = new SubagentRuntime({
				sessionFactory: factory,
				verificationRunner: verify,
				writerLeaseRegistry: new WriterLeaseRegistry(),
				runtimeRegistry: new WorkflowRuntimeRegistry(),
			});
			try {
				const agent = await runtime.spawn({
					workflowId: "workflow-1",
					taskId: "task-1",
					attemptId: "attempt-1",
					cwd: "C:/repo",
					profile: BUILTIN_AGENT_PROFILES.worker,
					parentPermission: FULL_PERMISSION_SET,
					workflowPermission: FULL_PERMISSION_SET,
					taskPermission: FULL_PERMISSION_SET,
					parentBudget: { maxAgentDepth: 2 },
					workflowBudget: { maxAgentDepth: 2 },
					taskBudget: {},
					verificationCommands: ["node verify.js", "node verify.js"],
				});
				await runtime.send(agent.id, "Implement the fix; the runtime owns acceptance commands");
				const session = factory.sessions[0]!;
				const edit = (id: string) => {
					session.emit({
						type: "tool_execution_start",
						toolName: "edit",
						toolCallId: id,
						args: { path: "src/index.ts" },
					});
					session.emit({ type: "tool_execution_end", toolName: "edit", toolCallId: id, isError: false });
				};
				edit("edit-1");
				session.complete(subagentHandoff({ changedFiles: ["src/index.ts"] }));
				await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
				if (failsInitially) {
					await vi.waitFor(() => expect(session.promptCalls).toHaveLength(2));
					expect(session.promptCalls[1]).toContain("focused assertion result");
					if (repair === "edit") edit("edit-2");
					if (repair === "bash") {
						session.emit({
							type: "tool_execution_start",
							toolName: "bash",
							toolCallId: "shell-fix",
							args: { command: "node repair.js" },
						});
						session.emit({
							type: "tool_execution_end",
							toolName: "bash",
							toolCallId: "shell-fix",
							isError: false,
						});
					}
					session.complete(subagentHandoff({ changedFiles: ["src/index.ts"] }));
					if (repair === "unchanged") {
						await vi.waitFor(() => expect(session.promptCalls).toHaveLength(3));
						session.complete(subagentHandoff({ changedFiles: ["src/index.ts"] }));
					}
				}
				await expect(runtime.wait(agent.id)).resolves.toMatchObject({
					status: repair === "unchanged" ? "failed" : "completed",
				});
				if (repair === "resume") {
					await runtime.resume(agent.id, "Revalidate the resumed task");
					session.complete(subagentHandoff());
					await expect(runtime.wait(agent.id)).resolves.toMatchObject({ status: "completed" });
				}
				expect(verify).toHaveBeenCalledTimes(repair === "none" || repair === "unchanged" ? 1 : 2);
				expect(factory.sessions).toHaveLength(1);
			} finally {
				await runtime.dispose();
			}
		},
	);
});
