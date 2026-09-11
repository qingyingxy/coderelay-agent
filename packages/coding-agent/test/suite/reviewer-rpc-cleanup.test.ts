import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SubagentReadonlyReviewer } from "../../src/core/delivery/reviewer-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { RpcSubagentSessionFactory } from "../../src/core/subagents/rpc-session.ts";
import { SubagentRuntime } from "../../src/core/subagents/subagent-runtime.ts";
import { CurrentWorkspaceProvider } from "../../src/core/subagents/workspace-provider.ts";
import { BUILTIN_AGENT_PROFILES } from "../../src/core/workflow/agent-profile.ts";
import { PlanWorkflowRuntime } from "../../src/core/workflow/plan-runtime.ts";
import { WorkflowRuntimeRegistry } from "../../src/core/workflow/runtime-registry.ts";
import { DEFAULT_WRITER_LEASE_REGISTRY } from "../../src/core/workflow/writer-lease.ts";
import { createHarness } from "./harness.ts";

it("stops an active RPC reviewer without leaving its child workflow lease", async () => {
	const harness = await createHarness();
	const root = fileURLToPath(new URL("../../../../", import.meta.url));
	const factory = new RpcSubagentSessionFactory({
		command: process.execPath,
		commandArgs: [
			join(root, "node_modules/tsx/dist/cli.mjs"),
			"--tsconfig",
			join(root, "tsconfig.json"),
			fileURLToPath(new URL("./fixtures/reviewer-lifecycle-child.ts", import.meta.url)),
		],
		env: { PI_CODING_AGENT_DIR: join(harness.tempDir, "child-config") },
	});
	const profile = BUILTIN_AGENT_PROFILES.reviewer;
	const session = factory.create({
		cwd: harness.tempDir,
		profile,
		modelName: "faux/strong",
		toolNames: ["read"],
		effectivePermissions: { ...profile.permissionCeiling, write: false, executeCommands: false, network: false },
		budget: { maxDurationMs: 30_000 },
	});
	try {
		await session.start();
		await session.prompt("Review the change");
		await expect.poll(() => existsSync(join(harness.tempDir, "review-started")), { timeout: 15_000 }).toBe(true);
		await session.stop();
		expect(DEFAULT_WRITER_LEASE_REGISTRY.get(harness.tempDir)).toBeUndefined();
	} finally {
		await session.stop();
		const lease = DEFAULT_WRITER_LEASE_REGISTRY.get(harness.tempDir);
		if (lease) DEFAULT_WRITER_LEASE_REGISTRY.releaseRecovered(lease.workflowId, harness.tempDir);
		harness.cleanup();
	}
}, 60_000);

it("retries a timed-out RPC review with one slot and releases both attempts", async () => {
	const harness = await createHarness();
	const root = fileURLToPath(new URL("../../../../", import.meta.url));
	const factory = new RpcSubagentSessionFactory({
		command: process.execPath,
		commandArgs: [
			join(root, "node_modules/tsx/dist/cli.mjs"),
			"--tsconfig",
			join(root, "tsconfig.json"),
			fileURLToPath(new URL("./fixtures/reviewer-lifecycle-child.ts", import.meta.url)),
		],
		env: { PI_CODING_AGENT_DIR: join(harness.tempDir, "child-config") },
	});
	const runtime = new SubagentRuntime({
		maxAgents: 1,
		maxAgentDurationMs: 20_000,
		workspaceProvider: new CurrentWorkspaceProvider(),
		runtimeRegistry: new WorkflowRuntimeRegistry(),
		sessionFactory: {
			create(config) {
				// Keep process startup independent of the deliberately short parent execution deadline.
				return factory.create({
					...config,
					modelName: "faux/strong",
					budget: { ...config.budget, maxDurationMs: 30_000 },
				});
			},
		},
	});
	const plan = PlanWorkflowRuntime.start(SessionManager.inMemory(), {
		workflowId: "rpc-timeout",
		rootTaskId: "root",
		planId: "plan",
		budget: { maxRetries: 1 },
		request: { text: "Review the change", cwd: harness.tempDir, attachments: [] },
	});
	try {
		const result = await new SubagentReadonlyReviewer(runtime).review({
			workflow: plan.workflow,
			rootTask: plan.tasks[0]!,
			diff: { files: [], changedFiles: [], summary: "Scoped review", evidenceRefs: [] },
		});
		expect(result.status).toBe("passed");
		const attempts = runtime.list();
		expect(attempts).toHaveLength(2);
		expect(attempts[0]?.lastError).toContain("exceeded 20000ms");
		expect(attempts.every((agent) => agent.sessionReleasedAt)).toBe(true);
		expect(runtime.availableSlots(plan.workflow.id)).toBe(1);
		expect(DEFAULT_WRITER_LEASE_REGISTRY.get(harness.tempDir)).toBeUndefined();
	} finally {
		await runtime.dispose();
		const lease = DEFAULT_WRITER_LEASE_REGISTRY.get(harness.tempDir);
		if (lease) DEFAULT_WRITER_LEASE_REGISTRY.releaseRecovered(lease.workflowId, harness.tempDir);
		harness.cleanup();
	}
}, 60_000);
