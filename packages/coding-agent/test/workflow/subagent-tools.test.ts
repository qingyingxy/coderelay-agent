import { describe, expect, it, vi } from "vitest";
import {
	AgentProfileLoader,
	createSubagentToolDefinitions,
	FULL_PERMISSION_SET,
	SubagentRuntime,
	SubagentToolController,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSessionFactory, SUBAGENT_HANDOFF } from "./subagent-fixtures.ts";

function setup() {
	const sessions = new FakeSubagentSessionFactory();
	let sequence = 0;
	const service = new SubagentRuntime({
		sessionFactory: sessions,
		writerLeaseRegistry: new WriterLeaseRegistry(),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
		createId: (kind) => `${kind}-${++sequence}`,
		now: () => 100,
	});
	const settle = vi.fn();
	const bind = vi.fn(async () => ({
		input: {
			workflowId: "workflow-1",
			taskId: "delegation-task-1",
			attemptId: "delegation-attempt-1",
			cwd: "C:/repo",
			parentPermission: FULL_PERMISSION_SET,
			workflowPermission: FULL_PERMISSION_SET,
			taskPermission: FULL_PERMISSION_SET,
			parentBudget: { maxAgentDepth: 2, maxRetries: 1 },
			workflowBudget: { maxConcurrentAgents: 2, maxAgentDepth: 2, maxRetries: 1 },
			taskBudget: { maxRetries: 1 },
		},
		settle,
	}));
	const controller = new SubagentToolController({
		service,
		profiles: new AgentProfileLoader({ cwd: "C:/repo", agentDir: "C:/agent" }),
		bind,
		inheritedContext: () => "Current request context",
	});
	return { bind, controller, service, sessions, settle };
}

describe("Subagent model tools", () => {
	it("exposes the three governed model tools", () => {
		const { controller } = setup();

		expect(createSubagentToolDefinitions(controller).map(({ name }) => name)).toEqual([
			"subagent",
			"get_subagent_result",
			"steer_subagent",
		]);
	});

	it("starts a background delegation through an authoritative binding", async () => {
		const { bind, controller, service, sessions } = setup();

		const view = await controller.delegate({
			prompt: "Inspect the runtime",
			description: "Runtime inspection",
			subagentType: "explorer",
			runInBackground: true,
			inheritContext: true,
		});

		expect(bind).toHaveBeenCalledWith(
			expect.objectContaining({
				description: "Runtime inspection",
				runInBackground: true,
			}),
		);
		expect(view).toMatchObject({
			status: "running",
			agent: {
				scope: "delegation",
				backend: "rpc",
				taskId: "delegation-task-1",
			},
		});
		expect(service.get(view.agent.id)).toMatchObject({ status: "running" });
		expect(sessions.sessions[0]?.promptCalls[0]).toContain("Current request context");
	});

	it("steers and waits for a background delegation", async () => {
		const { controller, sessions, settle } = setup();
		const started = await controller.delegate({
			prompt: "Inspect the runtime",
			description: "Runtime inspection",
			subagentType: "explorer",
			runInBackground: true,
		});

		await controller.steer({ agentId: started.agent.id, message: "Focus on cancellation races" });
		expect(sessions.sessions[0]?.steerCalls).toEqual(["Focus on cancellation races"]);

		const completion = controller.getResult({ agentId: started.agent.id, wait: true, verbose: true });
		sessions.sessions[0]?.complete(SUBAGENT_HANDOFF);
		const completed = await completion;

		expect(completed).toMatchObject({
			status: "completed",
			result: {
				status: "completed",
				handoff: {
					conclusion: "Inspection completed",
				},
			},
		});
		expect(completed.events?.map(({ type }) => type)).toContain("completed");
		expect(settle).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }), undefined);
		await expect(controller.steer({ agentId: started.agent.id, message: "Run again" })).rejects.toMatchObject({
			code: "subagent.not_steerable",
		});
	});

	it("rejects model and budget expansion before creating a binding", async () => {
		const { bind, controller } = setup();

		await expect(
			controller.delegate({
				prompt: "Inspect",
				description: "Inspection",
				subagentType: "explorer",
				model: "openai/other-model",
			}),
		).rejects.toMatchObject({ code: "subagent.model_override_denied" });
		await expect(
			controller.delegate({
				prompt: "Inspect",
				description: "Inspection",
				subagentType: "explorer",
				maxTurns: 11,
			}),
		).rejects.toMatchObject({ code: "subagent.budget_escalation" });
		expect(bind).not.toHaveBeenCalled();
	});

	it("honors an already-aborted signal before creating Workflow state", async () => {
		const { bind, controller } = setup();
		const abort = new AbortController();
		abort.abort();

		await expect(
			controller.delegate(
				{
					prompt: "Inspect",
					description: "Inspection",
					subagentType: "explorer",
				},
				abort.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(bind).not.toHaveBeenCalled();
	});
});
