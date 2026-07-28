import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	SessionWorkflowEventLog,
	WORKFLOW_EVENT_BATCH_CUSTOM_TYPE,
	WorkflowStore,
} from "../../src/core/workflow/index.ts";

describe("Direct Workflow request integration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-direct-workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[] = [], enableWorkflowTracking = true) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});
		if (enableWorkflowTracking) {
			session.enableWorkflowTracking();
		}
		session.agent.streamFunction = async () => {
			throw new Error("Stop after request setup");
		};
		return { session, sessionManager };
	}

	it("creates a Direct Workflow before running a top-level prompt", async () => {
		const { session, sessionManager } = await createSession();

		await session.prompt("Implement a small CLI change");

		const eventLog = new SessionWorkflowEventLog(sessionManager);
		const batches = eventLog.read();
		const workflowId = batches[0]?.batch.workflowId;
		expect(workflowId).toBeDefined();
		if (!workflowId) {
			throw new Error("Expected a Direct Workflow");
		}
		const store = new WorkflowStore();
		store.replay(batches.slice(0, 1));
		const workflow = store.getWorkflow(workflowId);
		const task = workflow?.rootTaskId ? store.getTask(workflow.rootTaskId) : undefined;

		expect(workflow).toMatchObject({
			status: "executing",
			request: {
				text: "Implement a small CLI change",
				cwd: tempDir,
				attachments: [],
			},
			modeDecision: {
				mode: "direct",
				source: "default",
				reason: "No explicit mode or Agent recommendation was available; using the Direct default",
				riskLevel: "low",
				decidedAt: expect.any(String),
			},
		});
		expect(task).toMatchObject({
			workflowId,
			status: "pending",
		});
		const branch = sessionManager.getBranch();
		const workflowEntryIndex = branch.findIndex(
			(entry) => entry.type === "custom" && entry.customType === WORKFLOW_EVENT_BATCH_CUSTOM_TYPE,
		);
		const userMessageIndex = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
		expect(workflowEntryIndex).toBeGreaterThanOrEqual(0);
		expect(userMessageIndex).toBeGreaterThan(workflowEntryIndex);

		session.dispose();
	});

	it("creates a different Workflow for each accepted idle prompt", async () => {
		const { session, sessionManager } = await createSession();

		await session.prompt("First request");
		await session.prompt("Second request");

		const batches = new SessionWorkflowEventLog(sessionManager).read();
		expect(new Set(batches.map(({ batch }) => batch.workflowId)).size).toBe(2);
		expect(
			batches.filter(({ batch }) => batch.events.some((event) => event.eventType === "workflow.created")),
		).toHaveLength(2);

		session.dispose();
	});

	it("does not create a Workflow for an extension command", async () => {
		const { session, sessionManager } = await createSession([
			(pi) => {
				pi.registerCommand("noop", {
					description: "Do nothing",
					handler: async () => {},
				});
			},
		]);
		await session.bindExtensions({});

		await session.prompt("/noop");

		expect(new SessionWorkflowEventLog(sessionManager).read()).toHaveLength(0);

		session.dispose();
	});

	it("does not persist a Workflow when prompt preflight fails", async () => {
		const { session, sessionManager } = await createSession();
		Object.assign(session.agent.state, { model: undefined });

		await expect(session.prompt("Cannot run")).rejects.toThrow("No model selected");

		expect(new SessionWorkflowEventLog(sessionManager).read()).toHaveLength(0);

		session.dispose();
	});

	it("does not change SDK prompt behavior until Workflow tracking is enabled", async () => {
		const { session, sessionManager } = await createSession([], false);

		expect(session.getAllTools().map(({ name }) => name)).not.toContain("subagent");
		await session.prompt("SDK request");

		expect(new SessionWorkflowEventLog(sessionManager).read()).toHaveLength(0);
		session.enableWorkflowTracking();
		expect(session.getAllTools().map(({ name }) => name)).toEqual(
			expect.arrayContaining(["subagent", "get_subagent_result", "steer_subagent"]),
		);

		session.dispose();
	});
});
