import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});

describe("Subagent enforcement", () => {
	it("compiles writable roots and passes only provider-specific credentials", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-enforcement-"));
		process.env.OPENAI_API_KEY = "test-openai-key";
		process.env.PI_R14_UNRELATED_SECRET = "must-not-leak";
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
});
