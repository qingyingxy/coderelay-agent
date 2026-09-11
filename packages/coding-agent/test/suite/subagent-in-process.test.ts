import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { LONG_TASK_WATCHDOG } from "../../src/core/workflow/execution-watchdog.ts";
import {
	BUILTIN_AGENT_PROFILES,
	FULL_PERMISSION_SET,
	InProcessSubagentSessionFactory,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { SUBAGENT_HANDOFF } from "../workflow/subagent-fixtures.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("In-process Subagent with Faux Provider", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it.each([false, true])(
		"runs a policy-approved read-only Agent without a child process (watchdog=%s)",
		async (watchdog) => {
			const factory = new InProcessSubagentSessionFactory(async (config) => {
				const harness = await createHarness({
					initialActiveToolNames: [...config.toolNames],
					allowedToolNames: [...config.toolNames],
				});
				harnesses.push(harness);
				harness.setResponses([fauxAssistantMessage(SUBAGENT_HANDOFF)]);
				return harness.session;
			});
			const runtime = new SubagentRuntime({
				executionWatchdog: watchdog ? LONG_TASK_WATCHDOG : undefined,
				sessionFactory: factory,
				inProcessSessionFactory: factory,
				runtimeRegistry: new WorkflowRuntimeRegistry(),
				writerLeaseRegistry: new WriterLeaseRegistry(),
			});
			const profile = BUILTIN_AGENT_PROFILES.explorer;
			const agent = await runtime.spawn({
				workflowId: "workflow-1",
				taskId: "task-1",
				attemptId: "attempt-1",
				cwd: process.cwd(),
				profile,
				backend: "in-process",
				parentPermission: FULL_PERMISSION_SET,
				workflowPermission: FULL_PERMISSION_SET,
				taskPermission: { ...FULL_PERMISSION_SET, write: false, executeCommands: false, network: false },
				parentBudget: { maxConcurrentAgents: 2, maxAgentDepth: 1 },
				workflowBudget: { maxConcurrentAgents: 2, maxAgentDepth: 1 },
				taskBudget: {},
			});

			await runtime.send(agent.id, "Inspect the repository");
			const result = await runtime.wait(agent.id);

			expect(result.error).toBeUndefined();
			expect(result).toMatchObject({
				status: "completed",
				handoff: { conclusion: "Inspection completed" },
			});
			expect(runtime.get(agent.id)).toMatchObject({
				backend: "in-process",
				status: "idle",
			});
			expect(harnesses[0]?.session.messages.some(({ role }) => role === "assistant")).toBe(true);
			await runtime.dispose();
		},
	);
});
