import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_PROFILES,
	CurrentWorkspaceProvider,
	compactTranscript,
	FULL_PERMISSION_SET,
	PlanWorkflowRuntime,
	SecretRedactor,
	SessionManager,
	SessionSubagentPersistence,
	SubagentPersistenceError,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	type WorkspaceProvider,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "./subagent-fixtures.ts";

function spawnInput() {
	return {
		workflowId: "workflow-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		cwd: "C:/repo",
		profile: BUILTIN_AGENT_PROFILES.explorer,
		parentPermission: FULL_PERMISSION_SET,
		workflowPermission: FULL_PERMISSION_SET,
		taskPermission: FULL_PERMISSION_SET,
		parentBudget: { maxAgentDepth: 1, maxRetries: 0 },
		workflowBudget: { maxAgentDepth: 1, maxRetries: 0 },
		taskBudget: { maxAgentDepth: 1, maxRetries: 0 },
	};
}

describe("SessionSubagentPersistence", () => {
	it("expires Transcript entries by the configured active and released ages", () => {
		const now = Date.parse("2026-07-29T00:10:00.000Z");
		const entries = [
			{
				sequence: 1,
				agentId: "agent-1",
				type: "activity" as const,
				text: "expired",
				occurredAt: "2026-07-29T00:00:00.000Z",
			},
			{
				sequence: 2,
				agentId: "agent-1",
				type: "assistant" as const,
				text: "retained",
				occurredAt: "2026-07-29T00:09:30.000Z",
			},
		];
		const retained = compactTranscript(
			entries,
			{
				maxTranscriptEntries: 10,
				maxReleasedTranscriptEntries: 5,
				maxTranscriptEntryChars: 100,
				maxTranscriptChars: 1_000,
				maxTranscriptAgeMs: 5 * 60_000,
				maxReleasedTranscriptAgeMs: 60_000,
				maxEvents: 10,
				checkpointEveryRecords: 5,
			},
			true,
			now,
		);

		expect(retained.map(({ text }) => text)).toEqual(["retained"]);
	});

	it("writes versioned records and redacts secrets before they reach the Session", () => {
		const session = SessionManager.inMemory("C:/repo");
		const persistence = new SessionSubagentPersistence(session, {
			redactor: new SecretRedactor(["raw-secret-value"]),
		});
		persistence.append({
			kind: "transcript",
			entry: {
				sequence: 1,
				agentId: "agent-1",
				type: "prompt",
				text: "Authorization: Bearer raw-secret-value",
				occurredAt: "2026-07-29T00:00:00.000Z",
			},
		});

		const serialized = JSON.stringify(session.getBranch());
		expect(serialized).not.toContain("raw-secret-value");
		expect(serialized).toContain("[REDACTED]");
		expect(persistence.load()).toEqual([
			expect.objectContaining({
				kind: "transcript",
				entry: expect.objectContaining({ text: "Authorization: [REDACTED]" }),
			}),
		]);
	});

	it("rejects unknown and malformed schemas instead of silently skipping them", () => {
		const unknown = SessionManager.inMemory("C:/repo");
		unknown.appendCustomEntry("subagent-runtime", {
			schemaVersion: 99,
			record: {},
		});
		expect(() => new SessionSubagentPersistence(unknown).load()).toThrowError(SubagentPersistenceError);

		const corrupt = SessionManager.inMemory("C:/repo");
		corrupt.appendCustomEntry("subagent-runtime", {
			schemaVersion: 2,
			record: { kind: "transcript", entry: { text: 123 } },
		});
		expect(() => new SessionSubagentPersistence(corrupt).load()).toThrowError("Subagent persistence entry");
	});

	it("migrates legacy unversioned records into the current typed view", () => {
		const session = SessionManager.inMemory("C:/repo");
		session.appendCustomEntry("subagent-runtime", {
			kind: "transcript",
			entry: {
				sequence: 1,
				agentId: "agent-legacy",
				type: "prompt",
				text: "Legacy prompt",
				occurredAt: "2026-07-29T00:00:00.000Z",
			},
		});

		expect(new SessionSubagentPersistence(session).load()).toEqual([
			expect.objectContaining({
				kind: "transcript",
				entry: expect.objectContaining({ agentId: "agent-legacy" }),
			}),
		]);
	});

	it("atomically compacts physical Session records to the latest checkpoint", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagent-checkpoint-"));
		try {
			const session = SessionManager.create(root, root);
			const persistence = new SessionSubagentPersistence(session);
			persistence.append({
				kind: "transcript",
				entry: {
					sequence: 1,
					agentId: "agent-old",
					type: "activity",
					text: "old",
					occurredAt: "2026-07-29T00:00:00.000Z",
				},
			});
			session.appendCustomEntry("other-extension", { retained: true });
			persistence.compact({
				schemaVersion: 1,
				createdAt: "2026-07-29T00:01:00.000Z",
				agents: [],
				handoffs: [],
				events: [],
				transcripts: [],
				spawnInputs: [],
			});
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			const reopened = SessionManager.open(sessionFile!, root);
			expect(
				reopened.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "subagent-runtime"),
			).toHaveLength(1);
			expect(
				reopened.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "other-extension"),
			).toHaveLength(1);
			expect(new SessionSubagentPersistence(reopened).load()).toEqual([
				expect.objectContaining({ kind: "checkpoint" }),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Subagent recovery", () => {
	it("creates a distinct recovery Agent from retained facts without consuming a model retry", async () => {
		const session = SessionManager.inMemory("C:/repo");
		const persistence = new SessionSubagentPersistence(session);
		const firstFactory = new FakeSubagentSessionFactory();
		const first = new SubagentRuntime({
			sessionFactory: firstFactory,
			workspaceProvider: new CurrentWorkspaceProvider(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
		});
		const source = await first.spawn(spawnInput());
		await first.send(source.id, "Inspect token=sk-recovery-secret");

		const secondFactory = new FakeSubagentSessionFactory();
		const recovered = new SubagentRuntime({
			sessionFactory: secondFactory,
			workspaceProvider: new CurrentWorkspaceProvider(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
		});
		try {
			expect(recovered.get(source.id)).toMatchObject({
				status: "interrupted",
				sessionReleasedAt: expect.any(String),
			});
			const recovery = await recovered.retry(source.id, {
				attemptId: "attempt-2",
				autoStart: false,
				recoveryReason: "Process restarted",
			});

			expect(recovery).toMatchObject({
				attemptId: "attempt-2",
				retryCount: 0,
				recoveryOfAgentId: source.id,
				recoveryContext: {
					sourceAttemptId: "attempt-1",
					reason: "Process restarted",
					workspace: { status: "available" },
				},
			});
			expect(recovery.recoveryContext?.lastPrompt).not.toContain("sk-recovery-secret");
			expect(secondFactory.sessions).toHaveLength(1);
			await expect(
				recovered.retry(source.id, {
					attemptId: "attempt-3",
					autoStart: false,
					recoveryReason: "Duplicate restart",
				}),
			).rejects.toMatchObject({
				code: "runtime_policy.recovery_exists",
			});
		} finally {
			await recovered.dispose();
			firstFactory.sessions[0]?.complete(subagentHandoff());
			await first.dispose();
		}
	});

	it("loads an interrupted Worktree Artifact patch into the recovery context", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagent-recovery-artifact-"));
		const patchPath = join(root, "interrupted.patch");
		writeFileSync(patchPath, "diff --git a/file.ts b/file.ts\n+recovered change\n", "utf8");
		const workspaceProvider: WorkspaceProvider = {
			async prepare(request) {
				return {
					id: `worktree:${request.agentId}`,
					path: root,
					kind: "git-worktree",
					repositoryIdentity: "repo:test",
					repositoryRoot: root,
					baselineCommit: "baseline",
					resultBranch: `agent/${request.agentId}`,
					assurance: "isolated",
				};
			},
			async createArtifact(workspace) {
				return {
					id: `artifact:${workspace.id}`,
					workspaceId: workspace.id,
					repositoryIdentity: "repo:test",
					baselineCommit: "baseline",
					resultCommit: "result",
					patchPath,
					changedFiles: ["file.ts"],
					status: "created",
					createdAt: "2026-07-29T00:00:00.000Z",
				};
			},
			async release() {},
			async validateRecovery() {
				return {
					status: "available",
					checkedAt: "2026-07-29T00:01:00.000Z",
					details: ["Interrupted Worktree is available"],
				};
			},
		};
		const session = SessionManager.inMemory(root);
		const persistence = new SessionSubagentPersistence(session);
		const firstFactory = new FakeSubagentSessionFactory();
		const first = new SubagentRuntime({
			sessionFactory: firstFactory,
			workspaceProvider,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
		});
		const source = await first.spawn({ ...spawnInput(), cwd: root });
		await first.send(source.id, "Continue the interrupted change");

		const recovered = new SubagentRuntime({
			sessionFactory: new FakeSubagentSessionFactory(),
			workspaceProvider,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
		});
		try {
			const recovery = await recovered.retry(source.id, {
				attemptId: "attempt-2",
				autoStart: false,
				recoveryReason: "Process restarted",
			});

			expect(recovery.recoveryContext).toMatchObject({
				artifact: { patchPath },
				artifactPatch: expect.stringContaining("+recovered change"),
				workspace: { status: "artifact-only" },
			});
		} finally {
			await recovered.dispose();
			firstFactory.sessions[0]?.complete(subagentHandoff());
			await first.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds released Transcript state through a compacted checkpoint", async () => {
		const session = SessionManager.inMemory("C:/repo");
		const persistence = new SessionSubagentPersistence(session);
		const factory = new FakeSubagentSessionFactory();
		const runtime = new SubagentRuntime({
			sessionFactory: factory,
			workspaceProvider: new CurrentWorkspaceProvider(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
			retentionPolicy: {
				maxTranscriptEntries: 4,
				maxReleasedTranscriptEntries: 3,
				maxTranscriptEntryChars: 80,
				maxTranscriptChars: 180,
				maxTranscriptAgeMs: 60_000,
				maxReleasedTranscriptAgeMs: 60_000,
				maxEvents: 8,
				checkpointEveryRecords: 2,
			},
		});
		const agent = await runtime.spawn(spawnInput());
		await runtime.send(agent.id, "Inspect");
		for (let index = 0; index < 8; index++) {
			factory.sessions[0]?.emit({
				type: "tool_execution_start",
				toolCallId: `tool-${index}`,
				toolName: "read",
				args: { path: `file-${index}.txt` },
			});
		}
		factory.sessions[0]?.complete(subagentHandoff());
		const completed = await runtime.wait(agent.id);
		await runtime.release(agent.id);
		expect(
			session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "subagent-runtime"),
		).toHaveLength(1);

		const restored = new SubagentRuntime({
			sessionFactory: new FakeSubagentSessionFactory(),
			workspaceProvider: new CurrentWorkspaceProvider(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
			retentionPolicy: {
				maxTranscriptEntries: 4,
				maxReleasedTranscriptEntries: 3,
				maxTranscriptEntryChars: 80,
				maxTranscriptChars: 180,
				maxTranscriptAgeMs: 60_000,
				maxReleasedTranscriptAgeMs: 60_000,
				maxEvents: 8,
				checkpointEveryRecords: 2,
			},
		});
		try {
			expect(restored.getTranscript(agent.id).entries.length).toBeLessThanOrEqual(3);
			expect(restored.events(agent.id).length).toBeLessThanOrEqual(8);
			expect(await restored.wait(agent.id)).toMatchObject({
				status: completed.status,
				handoff: { conclusion: completed.handoff?.conclusion },
			});
		} finally {
			await restored.dispose();
		}
	});

	it("binds automatic restart recovery to a new authoritative Workflow Attempt", async () => {
		const session = SessionManager.inMemory("C:/repo");
		const plan = PlanWorkflowRuntime.start(session, {
			workflowId: "workflow-recovery",
			rootTaskId: "root-recovery",
			planId: "plan-recovery",
			budget: { maxRetries: 0, maxConcurrentAgents: 1 },
			request: { text: "Recover Agent work", cwd: "C:/repo", attachments: [] },
		});
		plan.submit({
			goal: "Recover Agent work",
			assumptions: [],
			steps: [
				{
					id: "inspect",
					title: "Inspect",
					description: "Inspect the repository",
					dependsOn: [],
					fileIntents: [],
					verificationRequirementIds: ["manual"],
				},
			],
			risks: [],
			verificationRequirements: [
				{
					id: "manual",
					kind: "manual",
					description: "Inspection completed",
					required: true,
				},
			],
		});
		plan.approve();
		const persistence = new SessionSubagentPersistence(session);
		const firstFactory = new FakeSubagentSessionFactory();
		const firstRuntime = new SubagentRuntime({
			sessionFactory: firstFactory,
			workspaceProvider: new CurrentWorkspaceProvider(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
		});
		const [firstExecution] = await plan.startReadySubagents(firstRuntime, 1);
		expect(firstExecution).toBeDefined();

		const recoveredPlan = PlanWorkflowRuntime.recoverLatest(session, {}, "workflow-recovery");
		expect(recoveredPlan).toBeDefined();
		const secondFactory = new FakeSubagentSessionFactory();
		const secondRuntime = new SubagentRuntime({
			sessionFactory: secondFactory,
			workspaceProvider: new CurrentWorkspaceProvider(),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			persistence,
		});
		try {
			const [recoveryExecution] = await recoveredPlan!.startReadySubagents(secondRuntime, 1);
			expect(recoveryExecution?.agent).toMatchObject({
				recoveryOfAgentId: firstExecution!.agent.id,
				recoveryContext: {
					sourceAttemptId: firstExecution!.agent.attemptId,
				},
			});
			expect(recoveredPlan!.attempts.at(-1)).toMatchObject({
				recoveryOfAttemptId: firstExecution!.agent.attemptId,
				recoveryReason: "Interrupted during Session recovery",
			});
			secondFactory.sessions[0]?.complete(subagentHandoff());
			await recoveryExecution?.completion;
			expect(recoveredPlan!.tasks.find(({ sourcePlanStepId }) => sourcePlanStepId === "inspect")?.status).toBe(
				"succeeded",
			);
		} finally {
			await secondRuntime.dispose();
			await firstRuntime.interrupt(firstExecution!.agent.id, "Test cleanup").catch(() => undefined);
			await firstExecution?.completion.catch(() => undefined);
			await firstRuntime.dispose();
		}
	});
});
