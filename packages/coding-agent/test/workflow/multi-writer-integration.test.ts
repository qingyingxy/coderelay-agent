import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_PROFILES,
	evaluateMultiWriterCandidate,
	FULL_PERMISSION_SET,
	GitWorktreeWorkspaceProvider,
	type Handoff,
	type IntegrationPersistenceRecord,
	type MultiWriterIntegrationPersistence,
	MultiWriterIntegrationRuntime,
	type PostIntegrationVerification,
	type ResourceUsage,
	type SpawnSubagentInput,
	SubagentRuntime,
	TaskScheduler,
	WorkflowRuntimeRegistry,
	type WorkspaceArtifact,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "./subagent-fixtures.ts";

const ZERO_USAGE: ResourceUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	durationMs: 0,
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
}

function initializeRepository(root: string): void {
	git(root, "init");
	writeFileSync(join(root, "a.txt"), "a-initial\n", "utf8");
	writeFileSync(join(root, "b.txt"), "b-initial\n", "utf8");
	git(root, "add", "a.txt", "b.txt");
	git(root, "-c", "user.name=Pi Test", "-c", "user.email=pi-test@localhost", "commit", "-m", "initial");
}

function text(path: string): string {
	return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

function spawnInput(cwd: string, taskId: string, attemptId: string): SpawnSubagentInput {
	return {
		workflowId: "workflow-multi",
		taskId,
		attemptId,
		cwd,
		profile: BUILTIN_AGENT_PROFILES.worker,
		parentPermission: FULL_PERMISSION_SET,
		workflowPermission: FULL_PERMISSION_SET,
		taskPermission: FULL_PERMISSION_SET,
		parentBudget: {},
		workflowBudget: {},
		taskBudget: {},
	};
}

function handoff(agentId: string, taskId: string, attemptId: string, changedFiles: readonly string[]): Handoff {
	return {
		id: `handoff-${agentId}`,
		workflowId: "workflow-multi",
		taskId,
		attemptId,
		agentId,
		conclusion: `${agentId} completed`,
		evidence: changedFiles.map((path) => ({ path })),
		architectureFindings: [],
		changedFiles,
		verificationSummary: ["Local verification passed"],
		risks: [],
		unfinishedItems: [],
		createdAt: "2026-07-29T00:00:00.000Z",
	};
}

function passingVerification(): PostIntegrationVerification {
	return {
		reviewPassed: true,
		affectedTestsPassed: true,
		globalVerificationPassed: true,
		results: [],
		summary: "Review, affected tests, and global verification passed",
	};
}

function ownedArtifact(
	artifact: WorkspaceArtifact,
	agentId: string,
	taskId: string,
	attemptId: string,
	dependencyArtifactIds: readonly string[] = [],
): WorkspaceArtifact {
	return {
		...artifact,
		workflowId: "workflow-multi",
		taskId,
		attemptId,
		agentId,
		dependencyArtifactIds,
	};
}

class MemoryIntegrationPersistence implements MultiWriterIntegrationPersistence {
	readonly records: IntegrationPersistenceRecord[] = [];

	load(): readonly IntegrationPersistenceRecord[] {
		return structuredClone(this.records);
	}

	append(record: IntegrationPersistenceRecord): void {
		this.records.push(structuredClone(record));
	}
}

function metrics(overrides: Partial<ReturnType<typeof baseMetrics>> = {}) {
	return { ...baseMetrics(), ...overrides };
}

function baseMetrics() {
	return {
		runs: 3,
		successes: 3,
		successRate: 1,
		verificationPassRate: 1,
		reviewerEffectiveFindingRate: 1,
		repairSuccessRate: 1,
		invalidDelegationRate: 0,
		handoffCompletenessRate: 1,
		decisionExplanationRate: 1,
		usage: { ...ZERO_USAGE, cost: 1 },
		averageCostPerSuccess: 0.33,
		averageDurationMs: 1_000,
		averageAgentCount: 1,
	};
}

describe("MultiWriterIntegrationRuntime", () => {
	it("integrates independent Worktree Artifacts in deterministic serial order", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-multi-writer-independent-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "worktrees"),
			artifactDirectory: join(root, "artifacts"),
		});
		const firstWorkspace = await provider.prepare({
			agentId: "agent-a",
			backend: "rpc",
			write: true,
			input: spawnInput(repository, "task-a", "attempt-a"),
		});
		const secondWorkspace = await provider.prepare({
			agentId: "agent-b",
			backend: "rpc",
			write: true,
			input: spawnInput(repository, "task-b", "attempt-b"),
		});
		try {
			writeFileSync(join(firstWorkspace.path, "a.txt"), "a-result\n", "utf8");
			writeFileSync(join(secondWorkspace.path, "b.txt"), "b-result\n", "utf8");
			const first = ownedArtifact(
				(await provider.createArtifact(firstWorkspace, []))!,
				"agent-a",
				"task-a",
				"attempt-a",
			);
			const second = ownedArtifact(
				(await provider.createArtifact(secondWorkspace, []))!,
				"agent-b",
				"task-b",
				"attempt-b",
				[first.id],
			);
			const runtime = new MultiWriterIntegrationRuntime({
				workspaceProvider: provider,
				verifier: { verify: async () => passingVerification() },
				integrationLeaseRegistry: new WriterLeaseRegistry(),
			});

			await expect(
				runtime.integrate({ artifact: first, handoff: handoff("agent-a", "task-a", "attempt-a", ["a.txt"]) }),
			).resolves.toMatchObject({
				status: "integrated",
			});
			await expect(
				runtime.integrate({ artifact: second, handoff: handoff("agent-b", "task-b", "attempt-b", ["b.txt"]) }),
			).resolves.toMatchObject({
				status: "integrated",
			});
			expect(text(join(repository, "a.txt"))).toBe("a-result\n");
			expect(text(join(repository, "b.txt"))).toBe("b-result\n");
			expect(runtime.attempts().map(({ status }) => status)).toEqual(["integrated", "integrated"]);
		} finally {
			await provider.release(firstWorkspace);
			await provider.release(secondWorkspace);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves both Artifacts and Handoffs in a Conflict Resolution Attempt", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-multi-writer-conflict-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "worktrees"),
			artifactDirectory: join(root, "artifacts"),
		});
		const firstWorkspace = await provider.prepare({
			agentId: "agent-a",
			backend: "rpc",
			write: true,
			input: spawnInput(repository, "task-a", "attempt-a"),
		});
		const secondWorkspace = await provider.prepare({
			agentId: "agent-b",
			backend: "rpc",
			write: true,
			input: spawnInput(repository, "task-b", "attempt-b"),
		});
		try {
			writeFileSync(join(firstWorkspace.path, "a.txt"), "first\n", "utf8");
			writeFileSync(join(secondWorkspace.path, "a.txt"), "second\n", "utf8");
			const first = ownedArtifact(
				(await provider.createArtifact(firstWorkspace, []))!,
				"agent-a",
				"task-a",
				"attempt-a",
			);
			const second = ownedArtifact(
				(await provider.createArtifact(secondWorkspace, []))!,
				"agent-b",
				"task-b",
				"attempt-b",
			);
			const persistence = new MemoryIntegrationPersistence();
			const runtime = new MultiWriterIntegrationRuntime({
				workspaceProvider: provider,
				verifier: { verify: async () => passingVerification() },
				integrationLeaseRegistry: new WriterLeaseRegistry(),
				persistence,
				createId: (kind) => `${kind}-${persistence.records.length + 1}`,
			});
			await runtime.integrate({
				artifact: first,
				handoff: handoff("agent-a", "task-a", "attempt-a", ["a.txt"]),
			});

			await expect(
				runtime.integrate({
					artifact: second,
					handoff: handoff("agent-b", "task-b", "attempt-b", ["a.txt"]),
				}),
			).rejects.toMatchObject({
				code: "integration.conflict",
				artifact: { status: "conflicted" },
			});
			expect(runtime.conflicts()[0]).toMatchObject({
				status: "pending",
				sourceArtifact: { id: second.id },
				conflictingArtifacts: [{ id: first.id }],
				sourceHandoff: { agentId: "agent-b" },
				conflictingHandoffs: [{ agentId: "agent-a" }],
				analysis: {
					conflicts: [expect.objectContaining({ reason: "path_overlap", path: "a.txt" })],
				},
			});
			expect(text(join(repository, "a.txt"))).toBe("first\n");
			expect(persistence.records.some(({ kind }) => kind === "conflict")).toBe(true);
		} finally {
			await provider.release(firstWorkspace);
			await provider.release(secondWorkspace);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rolls back the exact Artifact when post-integration verification fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-multi-writer-rollback-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "worktrees"),
			artifactDirectory: join(root, "artifacts"),
		});
		const workspace = await provider.prepare({
			agentId: "agent-a",
			backend: "rpc",
			write: true,
			input: spawnInput(repository, "task-a", "attempt-a"),
		});
		try {
			writeFileSync(join(workspace.path, "a.txt"), "bad-result\n", "utf8");
			const artifact = ownedArtifact(
				(await provider.createArtifact(workspace, []))!,
				"agent-a",
				"task-a",
				"attempt-a",
			);
			const runtime = new MultiWriterIntegrationRuntime({
				workspaceProvider: provider,
				integrationLeaseRegistry: new WriterLeaseRegistry(),
				verifier: {
					verify: async () => ({
						...passingVerification(),
						affectedTestsPassed: false,
						summary: "Affected tests failed",
					}),
				},
			});

			await expect(
				runtime.integrate({
					artifact,
					handoff: handoff("agent-a", "task-a", "attempt-a", ["a.txt"]),
				}),
			).rejects.toMatchObject({
				code: "integration.verification_failed",
				artifact: { status: "rolled_back" },
			});
			expect(text(join(repository, "a.txt"))).toBe("a-initial\n");
			expect(runtime.attempts()[0]).toMatchObject({
				status: "rolled_back",
				verification: {
					reviewPassed: true,
					affectedTestsPassed: false,
					globalVerificationPassed: true,
				},
			});
		} finally {
			await provider.release(workspace);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Multi-Writer admission", () => {
	it("uses one Workspace Writer Lease per isolated Worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-multi-writer-leases-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const leases = new WriterLeaseRegistry();
		const sessions = new FakeSubagentSessionFactory();
		const runtime = new SubagentRuntime({
			sessionFactory: sessions,
			workspaceProvider: new GitWorktreeWorkspaceProvider({
				baseDirectory: join(root, "worktrees"),
				artifactDirectory: join(root, "artifacts"),
			}),
			writerLeaseRegistry: leases,
			runtimeRegistry: new WorkflowRuntimeRegistry(),
			maxAgents: 2,
			multiWriter: {
				maxConcurrentWriters: 2,
				verifier: { verify: async () => passingVerification() },
				integrationLeaseRegistry: new WriterLeaseRegistry(),
			},
		});
		try {
			const first = await runtime.spawn(spawnInput(repository, "task-a", "attempt-a"));
			const second = await runtime.spawn(spawnInput(repository, "task-b", "attempt-b"));
			expect(runtime.reserveWriter(first.id)).toBeTypeOf("string");
			expect(runtime.reserveWriter(second.id)).toBeTypeOf("string");
			expect(leases.list()).toHaveLength(2);
			expect(new Set(leases.list().map(({ workspace }) => workspace)).size).toBe(2);
			writeFileSync(join(first.workspace!.path, "a.txt"), "first-runtime\n", "utf8");
			writeFileSync(join(second.workspace!.path, "b.txt"), "second-runtime\n", "utf8");
			await Promise.all([runtime.send(first.id, "Modify a.txt"), runtime.send(second.id, "Modify b.txt")]);
			sessions.sessions[0]?.complete(subagentHandoff({ changedFiles: ["a.txt"] }));
			sessions.sessions[1]?.complete(subagentHandoff({ changedFiles: ["b.txt"] }));
			const results = await Promise.all([runtime.wait(first.id), runtime.wait(second.id)]);
			expect(results.map(({ artifact }) => artifact?.status)).toEqual(["integrated", "integrated"]);
			expect(runtime.integrationAttempts("workflow-multi")).toHaveLength(2);
			expect(text(join(repository, "a.txt"))).toBe("first-runtime\n");
			expect(text(join(repository, "b.txt"))).toBe("second-runtime\n");
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("selects multiple Writer Tasks only when isolated Writer capacity is enabled", () => {
		const tasks = ["task-a", "task-b"].map((id) => ({
			schemaVersion: 1,
			revision: 1,
			createdAt: "2026-07-29T00:00:00.000Z",
			updatedAt: "2026-07-29T00:00:00.000Z",
			id,
			workflowId: "workflow-multi",
			kind: "agent" as const,
			accessMode: "writer" as const,
			title: id,
			description: id,
			status: "ready" as const,
			dependencyIds: [],
			budget: {},
			usage: ZERO_USAGE,
			attemptIds: [],
			verificationRequirements: [],
			modifications: [],
		}));
		expect(
			new TaskScheduler({
				maxConcurrency: 2,
				maxConcurrentAgents: 2,
				agentExecutorKind: "subagent",
			}).select(tasks),
		).toHaveLength(1);
		expect(
			new TaskScheduler({
				maxConcurrency: 2,
				maxConcurrentAgents: 2,
				agentExecutorKind: "subagent",
				allowParallelWriters: true,
				maxConcurrentWriters: 2,
			}).select(tasks),
		).toHaveLength(2);
	});

	it("keeps Multi-Writer disabled without repeated speed, quality, conflict, and rollback evidence", () => {
		expect(
			evaluateMultiWriterCandidate({
				baseline: metrics(),
				multiWriter: metrics({ runs: 1, averageDurationMs: 500 }),
				integrationAttempts: 1,
				conflictAttempts: 0,
				rollbackAttempts: 0,
				successfulRollbacks: 0,
			}).eligible,
		).toBe(false);
		expect(
			evaluateMultiWriterCandidate({
				baseline: metrics(),
				multiWriter: metrics({
					averageDurationMs: 700,
					averageAgentCount: 2,
					usage: { ...ZERO_USAGE, cost: 1.2 },
				}),
				integrationAttempts: 20,
				conflictAttempts: 1,
				rollbackAttempts: 2,
				successfulRollbacks: 2,
			}),
		).toEqual({ eligible: true, findings: [] });
	});
});
