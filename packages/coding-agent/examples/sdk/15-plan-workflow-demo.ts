/**
 * Plan Workflow Demo
 *
 * Runs a deterministic, no-network Plan workflow with a read-only Planner,
 * explicit approval, and Plan-to-Task materialization.
 *
 * Run from the repository root:
 *   npm run demo:plan-workflow
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type PlanContent,
	type ResourceLoader,
	SessionManager,
	SessionWorkflowEventLog,
	SettingsManager,
	WorkflowStore,
} from "@earendil-works/pi-coding-agent";

const workspace = mkdtempSync(join(tmpdir(), "pi-plan-workflow-demo-"));
const plannedPath = "src/plan-demo.ts";
const request = "Plan a multi-file CLI workflow change without modifying the repository before approval.";
const content: PlanContent = {
	goal: "Add a formal Plan workflow demo",
	assumptions: ["The existing Workflow Event Log remains authoritative"],
	steps: [
		{
			id: "step-1",
			title: "Implement the Plan workflow",
			description: "Add the Plan workflow behavior to the CLI core",
			dependsOn: [],
			fileIntents: [
				{
					path: plannedPath,
					action: "create",
					reason: "Demonstrate a planned file change",
				},
			],
			verificationRequirementIds: ["verify-plan"],
		},
		{
			id: "step-2",
			title: "Verify the Plan workflow",
			description: "Run the focused Plan workflow tests",
			dependsOn: ["step-1"],
			fileIntents: [],
			verificationRequirementIds: ["verify-plan"],
		},
	],
	risks: [
		{
			level: "low",
			description: "The demo must not modify files before approval",
			mitigation: "Run the Planner with read-only tools",
		},
	],
	verificationRequirements: [
		{
			id: "verify-plan",
			kind: "test",
			description: "Run Plan workflow tests",
			required: true,
		},
	],
};
const faux = registerFauxProvider();
let disposeSession: (() => void) | undefined;

try {
	const model = faux.getModel();
	faux.setResponses([fauxAssistantMessage(JSON.stringify(content))]);
	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	await modelRuntime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Return the supplied structured Plan without modifying files.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const sessionManager = SessionManager.inMemory(workspace);
	const { session } = await createAgentSession({
		cwd: workspace,
		agentDir: workspace,
		model,
		modelRuntime,
		resourceLoader,
		tools: ["read", "edit", "write"],
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});
	disposeSession = () => session.dispose();
	session.enableWorkflowTracking();
	session.subscribe((event) => {
		if (
			event.type === "message_start" &&
			event.message.role === "custom" &&
			event.message.customType === "workflow" &&
			typeof event.message.content === "string"
		) {
			console.log(event.message.content);
		}
	});

	console.log(`[request] ${request}`);
	await session.prompt("/plan");
	await session.prompt(request);
	if (existsSync(join(workspace, plannedPath))) {
		throw new Error("Planner modified the repository before approval");
	}
	await session.prompt("/workflow");
	await session.prompt("/approve demo-approved");
	await session.prompt("/workflow");

	const batches = new SessionWorkflowEventLog(sessionManager).read();
	const workflowId = batches[0]?.batch.workflowId;
	if (!workflowId) {
		throw new Error("Plan Workflow demo did not create a Workflow");
	}
	const store = new WorkflowStore();
	store.replay(batches);
	const workflow = store.getWorkflow(workflowId);
	const plan = workflow?.currentPlanId ? store.getPlan(workflow.currentPlanId) : undefined;
	const stepTasks = store.listTasks(workflowId).filter(({ sourcePlanId }) => sourcePlanId === plan?.id);
	if (workflow?.status !== "executing" || plan?.status !== "approved" || stepTasks.length !== 2) {
		throw new Error("Plan Workflow demo did not materialize the approved Task graph");
	}
	if (existsSync(join(workspace, plannedPath))) {
		throw new Error("R5 demo unexpectedly executed a planned Task before the R6 Scheduler");
	}
	console.log("[demo] PASS");
} finally {
	disposeSession?.();
	faux.unregister();
	rmSync(workspace, { recursive: true, force: true });
}
