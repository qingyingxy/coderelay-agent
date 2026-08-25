import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BaselineSandboxBackend,
	BUILTIN_AGENT_PROFILES,
	CurrentWorkspaceProvider,
	compileAgentEnforcementPlan,
	FULL_PERMISSION_SET,
	providerEnvironmentKeys,
	SandboxPolicyError,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSessionFactory } from "./subagent-fixtures.ts";

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_UNRELATED_SECRET = process.env.PI_R14_UNRELATED_SECRET;
const ORIGINAL_EVALUATION_NODE = process.env.PI_EVALUATION_NODE;
const ORIGINAL_EVALUATION_NODE_MODULES = process.env.PI_EVALUATION_NODE_MODULES;

afterEach(() => {
	if (ORIGINAL_OPENAI_KEY === undefined) {
		delete process.env.OPENAI_API_KEY;
	} else {
		process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
	}
	if (ORIGINAL_UNRELATED_SECRET === undefined) {
		delete process.env.PI_R14_UNRELATED_SECRET;
	} else {
		process.env.PI_R14_UNRELATED_SECRET = ORIGINAL_UNRELATED_SECRET;
	}
	if (ORIGINAL_EVALUATION_NODE === undefined) {
		delete process.env.PI_EVALUATION_NODE;
	} else {
		process.env.PI_EVALUATION_NODE = ORIGINAL_EVALUATION_NODE;
	}
	if (ORIGINAL_EVALUATION_NODE_MODULES === undefined) {
		delete process.env.PI_EVALUATION_NODE_MODULES;
	} else {
		process.env.PI_EVALUATION_NODE_MODULES = ORIGINAL_EVALUATION_NODE_MODULES;
	}
});

describe("Subagent enforcement", () => {
	it("compiles writable roots and passes only provider-specific credentials", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-enforcement-"));
		process.env.OPENAI_API_KEY = "test-openai-key";
		process.env.PI_R14_UNRELATED_SECRET = "must-not-leak";
		process.env.PI_EVALUATION_NODE = "C:/runtime/node.exe";
		process.env.PI_EVALUATION_NODE_MODULES = "C:/runtime/node_modules";
		try {
			const plan = compileAgentEnforcementPlan({
				mode: "best-effort",
				backend: "rpc",
				workspace: {
					id: "workspace-1",
					path: cwd,
					kind: "git-worktree",
					assurance: "isolated",
				},
				permissions: BUILTIN_AGENT_PROFILES.worker.permissionCeiling,
				providerEnvironmentKeys: providerEnvironmentKeys("openai/test-model"),
			});
			const backend = new BaselineSandboxBackend();
			const handle = await backend.prepare({ agentId: "agent-1", backend: "rpc", plan });

			expect(plan.filesystem.writableRoots).toEqual([cwd]);
			expect(handle.environment.OPENAI_API_KEY).toBe("test-openai-key");
			expect(handle.environment.PI_R14_UNRELATED_SECRET).toBeUndefined();
			expect(handle.environment.PI_EVALUATION_NODE).toBe("C:/runtime/node.exe");
			expect(handle.environment.PI_EVALUATION_NODE_MODULES).toBe("C:/runtime/node_modules");
			expect(handle.verification).toMatchObject({
				assurance: "process-restricted",
				mode: "best-effort",
				platform: process.platform,
			});
			expect(handle.verification.missingGuarantees).toContain(
				"command child processes are not filesystem-sandboxed",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects strict execution when command or network isolation is unavailable", async () => {
		const plan = compileAgentEnforcementPlan({
			mode: "strict",
			backend: "rpc",
			workspace: { id: "workspace-1", path: process.cwd() },
			permissions: FULL_PERMISSION_SET,
		});

		await expect(
			new BaselineSandboxBackend().prepare({ agentId: "agent-1", backend: "rpc", plan }),
		).rejects.toBeInstanceOf(SandboxPolicyError);
	});

	it("rejects strict write execution when an isolated Workspace is unavailable", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-strict-workspace-"));
		const runtime = new SubagentRuntime({
			sessionFactory: new FakeSubagentSessionFactory(),
			workspaceProvider: new CurrentWorkspaceProvider(),
			enforcementMode: "strict",
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		try {
			await expect(
				runtime.spawn({
					workflowId: "workflow-1",
					taskId: "task-1",
					attemptId: "attempt-1",
					cwd,
					profile: BUILTIN_AGENT_PROFILES.worker,
					parentPermission: FULL_PERMISSION_SET,
					workflowPermission: FULL_PERMISSION_SET,
					taskPermission: FULL_PERMISSION_SET,
					parentBudget: {},
					workflowBudget: {},
					taskBudget: {},
				}),
			).rejects.toMatchObject({
				code: "workspace.strict_isolation_unavailable",
			});
		} finally {
			await runtime.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("adds evaluation protected paths to the effective permission and enforcement plan", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-protected-paths-"));
		const runtime = new SubagentRuntime({
			sessionFactory: new FakeSubagentSessionFactory(),
			workspaceProvider: new CurrentWorkspaceProvider(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			writeDeniedPaths: ["test", "verify.js", "package.json"],
		});
		try {
			const agent = await runtime.spawn({
				workflowId: "workflow-protected-paths",
				taskId: "task-protected-paths",
				attemptId: "attempt-protected-paths",
				cwd,
				profile: BUILTIN_AGENT_PROFILES.worker,
				parentPermission: FULL_PERMISSION_SET,
				workflowPermission: FULL_PERMISSION_SET,
				taskPermission: FULL_PERMISSION_SET,
				parentBudget: {},
				workflowBudget: {},
				taskBudget: {},
			});

			expect(agent.effectivePermissions.deniedPaths).toEqual([]);
			expect(agent.enforcementPlan?.filesystem.writeDeniedRoots).toEqual(
				["test", "verify.js", "package.json"].map((path) => resolve(cwd, path)).sort(),
			);
		} finally {
			await runtime.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
