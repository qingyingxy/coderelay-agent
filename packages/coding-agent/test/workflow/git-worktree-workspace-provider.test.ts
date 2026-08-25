import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_PROFILES,
	FULL_PERMISSION_SET,
	GitWorktreeWorkspaceError,
	GitWorktreeWorkspaceProvider,
	type SpawnSubagentInput,
	SubagentRuntime,
	WorkflowRuntimeRegistry,
	WorkspaceIntegrationQueue,
	WriterLeaseRegistry,
} from "../../src/index.ts";
import { FakeSubagentSessionFactory, subagentHandoff } from "./subagent-fixtures.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
}

function text(path: string): string {
	return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

function initializeRepository(root: string): void {
	git(root, "init");
	writeFileSync(join(root, "file.txt"), "initial\n", "utf8");
	git(root, "add", "file.txt");
	git(root, "-c", "user.name=Pi Test", "-c", "user.email=pi-test@localhost", "commit", "-m", "test: initial");
}

function spawnInput(cwd: string): SpawnSubagentInput {
	return {
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
	};
}

describe("GitWorktreeWorkspaceProvider", () => {
	it("snapshots dirty state, creates an Artifact, and integrates only the Agent delta", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-provider-"));
		const repository = join(root, "repository");
		const workspaceBase = join(root, "workspaces");
		const artifactBase = join(root, "artifacts");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		writeFileSync(join(repository, "file.txt"), "user baseline\n", "utf8");
		writeFileSync(join(repository, "user-note.txt"), "keep me\n", "utf8");
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: workspaceBase,
			artifactDirectory: artifactBase,
			createId: () => "one",
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-1",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});

			expect(workspace).toMatchObject({
				kind: "git-worktree",
				assurance: "isolated",
				repositoryRoot: repository,
			});
			expect(text(join(workspace.path, "file.txt"))).toBe("user baseline\n");
			expect(text(join(workspace.path, "user-note.txt"))).toBe("keep me\n");

			writeFileSync(join(workspace.path, "file.txt"), "agent result\n", "utf8");
			writeFileSync(join(workspace.path, "agent-file.txt"), "created by agent\n", "utf8");
			const artifact = await provider.createArtifact(workspace, []);
			expect(artifact).toMatchObject({
				status: "created",
				changedFiles: ["agent-file.txt", "file.txt"],
			});
			const integrated = await provider.integrateArtifact(artifact!);

			expect(integrated.status).toBe("integrated");
			expect(text(join(repository, "file.txt"))).toBe("agent result\n");
			expect(text(join(repository, "user-note.txt"))).toBe("keep me\n");
			expect(text(join(repository, "agent-file.txt"))).toBe("created by agent\n");
			expect(existsSync(integrated.patchPath)).toBe(true);

			await provider.release(workspace);
			expect(existsSync(workspace.path)).toBe(false);
			expect(existsSync(integrated.patchPath)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects integration when the target repository changed after preparation", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-conflict-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "workspaces"),
			artifactDirectory: join(root, "artifacts"),
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-conflict",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});
			writeFileSync(join(workspace.path, "file.txt"), "agent result\n", "utf8");
			const artifact = await provider.createArtifact(workspace, []);
			writeFileSync(join(repository, "file.txt"), "external change\n", "utf8");

			await expect(provider.integrateArtifact(artifact!)).rejects.toBeInstanceOf(GitWorktreeWorkspaceError);
			expect(text(join(repository, "file.txt"))).toBe("external change\n");
			await provider.release(workspace);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retries transient Worktree removal failures before releasing metadata", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-release-retry-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		let removalAttempts = 0;
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "workspaces"),
			artifactDirectory: join(root, "artifacts"),
			releaseRetryDelayMs: 0,
			removeWorktree: async (repositoryRoot, worktreeRoot) => {
				removalAttempts++;
				if (removalAttempts < 3) {
					throw new Error("transient access denied");
				}
				execFileSync("git", ["-C", repositoryRoot, "worktree", "remove", "--force", worktreeRoot], {
					windowsHide: true,
				});
			},
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-release-retry",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});

			await provider.release(workspace);

			expect(removalAttempts).toBe(3);
			expect(existsSync(workspace.path)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("finishes cleanup when Git unregisters the Worktree before directory removal fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-unregistered-release-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		let removalAttempts = 0;
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "workspaces"),
			artifactDirectory: join(root, "artifacts"),
			releaseRetryDelayMs: 0,
			removeWorktree: async (repositoryRoot, worktreeRoot) => {
				removalAttempts++;
				execFileSync("git", ["-C", repositoryRoot, "worktree", "remove", "--force", worktreeRoot], {
					windowsHide: true,
				});
				mkdirSync(worktreeRoot, { recursive: true });
				throw new Error("directory removal failed after Worktree unregister");
			},
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-unregistered-release",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});

			await provider.release(workspace);

			expect(removalAttempts).toBe(1);
			expect(existsSync(workspace.path)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deduplicates concurrent release calls for one Worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-concurrent-release-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		let removalAttempts = 0;
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "workspaces"),
			artifactDirectory: join(root, "artifacts"),
			removeWorktree: async (repositoryRoot, worktreeRoot) => {
				removalAttempts++;
				await new Promise((resolve) => setTimeout(resolve, 10));
				execFileSync("git", ["-C", repositoryRoot, "worktree", "remove", "--force", worktreeRoot], {
					windowsHide: true,
				});
			},
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-concurrent-release",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});

			await Promise.all([provider.release(workspace), provider.release(workspace)]);

			expect(removalAttempts).toBe(1);
			expect(existsSync(workspace.path)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes an orphaned Worktree after its source repository was deleted", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-missing-repository-"));
		const repository = join(root, "repository");
		const workspaceBase = join(root, "workspaces");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: workspaceBase,
			artifactDirectory: join(root, "artifacts"),
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-missing-repository",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});
			const worktreeRoot = workspace.path;
			rmSync(repository, { recursive: true, force: true });

			await provider.release(workspace);

			expect(existsSync(worktreeRoot)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("recovers metadata and removes a Worktree whose owner process is gone", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-orphan-"));
		const repository = join(root, "repository");
		const workspaceBase = join(root, "workspaces");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: workspaceBase,
			artifactDirectory: join(root, "artifacts"),
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-orphan",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});
			const repositoryDirectory = readdirSync(workspaceBase)[0];
			expect(repositoryDirectory).toBeDefined();
			const metadataDirectory = join(workspaceBase, repositoryDirectory!, "metadata");
			const metadataFile = readdirSync(metadataDirectory).find((path) => path.endsWith(".json"));
			expect(metadataFile).toBeDefined();
			const metadataPath = join(metadataDirectory, metadataFile!);
			const metadata: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
			expect(metadata).toBeTypeOf("object");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					...(metadata as Record<string, unknown>),
					ownerPid: 2_147_483_647,
				}),
				"utf8",
			);

			const recoveredProvider = new GitWorktreeWorkspaceProvider({
				baseDirectory: workspaceBase,
				artifactDirectory: join(root, "artifacts"),
			});
			const cleaned = await recoveredProvider.cleanupOrphans(new Set());

			expect(cleaned).toEqual([workspace.id]);
			expect(existsSync(workspace.path)).toBe(false);
			expect(existsSync(metadataPath)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("verifies retained Artifact integrity before recovery", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-recovery-integrity-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "workspaces"),
			artifactDirectory: join(root, "artifacts"),
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-integrity",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});
			writeFileSync(join(workspace.path, "file.txt"), "agent result\n", "utf8");
			const artifact = await provider.createArtifact(workspace, []);
			expect(artifact).toBeDefined();
			await expect(provider.validateRecovery(workspace, artifact)).resolves.toMatchObject({
				status: "available",
				details: expect.arrayContaining(["Artifact Patch digest verified"]),
			});

			writeFileSync(artifact!.patchPath, "tampered", "utf8");
			await expect(provider.validateRecovery(workspace, artifact)).resolves.toMatchObject({
				status: "invalid",
			});
			await provider.release(workspace);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores a failed Agent Artifact into a fresh Worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-repair-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "workspaces"),
			artifactDirectory: join(root, "artifacts"),
		});
		try {
			const first = await provider.prepare({
				agentId: "agent-first",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});
			writeFileSync(join(first.path, "file.txt"), "partial repair\n", "utf8");
			const artifact = await provider.createArtifact(first, []);
			expect(artifact?.changedFiles).toEqual(["file.txt"]);
			await provider.release(first);

			const second = await provider.prepare({
				agentId: "agent-second",
				backend: "rpc",
				write: true,
				input: { ...spawnInput(repository), attemptId: "attempt-2" },
			});
			await provider.restoreArtifact(second, artifact!);

			expect(text(join(second.path, "file.txt"))).toBe("partial repair\n");
			expect(text(join(repository, "file.txt"))).toBe("initial\n");
			await provider.release(second);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects corrupt recovery metadata without deleting the Worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-corrupt-metadata-"));
		const repository = join(root, "repository");
		const workspaceBase = join(root, "workspaces");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: workspaceBase,
			artifactDirectory: join(root, "artifacts"),
		});
		try {
			const workspace = await provider.prepare({
				agentId: "agent-corrupt",
				backend: "rpc",
				write: true,
				input: spawnInput(repository),
			});
			const repositoryDirectory = readdirSync(workspaceBase)[0]!;
			const metadataDirectory = join(workspaceBase, repositoryDirectory, "metadata");
			const metadataFile = readdirSync(metadataDirectory).find((path) => path.endsWith(".json"))!;
			writeFileSync(join(metadataDirectory, metadataFile), "{invalid", "utf8");
			const recoveredProvider = new GitWorktreeWorkspaceProvider({
				baseDirectory: workspaceBase,
				artifactDirectory: join(root, "artifacts"),
			});

			await expect(recoveredProvider.cleanupOrphans(new Set())).rejects.toMatchObject({
				code: "workspace.metadata_corrupt",
			});
			expect(existsSync(workspace.path)).toBe(true);
			await provider.release(workspace);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("WorkspaceIntegrationQueue", () => {
	it("serializes integration per repository while allowing different repositories to proceed", async () => {
		const queue = new WorkspaceIntegrationQueue();
		const order: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const first = queue.run("repo-a", async () => {
			order.push("first-start");
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			order.push("first-end");
		});
		const second = queue.run("repo-a", async () => {
			order.push("second");
		});
		const other = queue.run("repo-b", async () => {
			order.push("other");
		});
		await other;
		expect(order).toEqual(["first-start", "other"]);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "other", "first-end", "second"]);
	});
});

describe("SubagentRuntime Worktree integration", () => {
	it("preserves failed Worker code and diagnostics for the next repair Agent", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-worktree-repair-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const factory = new FakeSubagentSessionFactory();
		const runtime = new SubagentRuntime({
			sessionFactory: factory,
			workspaceProvider: new GitWorktreeWorkspaceProvider({
				baseDirectory: join(root, "workspaces"),
				artifactDirectory: join(root, "artifacts"),
			}),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		try {
			const first = await runtime.spawn({
				...spawnInput(repository),
				parentBudget: { maxRetries: 1 },
				workflowBudget: { maxRetries: 1 },
				taskBudget: { maxRetries: 1 },
			});
			await runtime.send(first.id, "Implement the scoped repair and run npm test");
			writeFileSync(join(first.workspace!.path, "file.txt"), "partial implementation\n", "utf8");
			factory.sessions[0]?.emit({
				type: "tool_execution_start",
				toolCallId: "command-1",
				toolName: "bash",
				args: { command: "npm test" },
			});
			factory.sessions[0]?.fail(new Error("Worker timed out"));

			const failed = await runtime.wait(first.id);
			expect(failed).toMatchObject({
				status: "failed",
				artifact: { changedFiles: ["file.txt"] },
			});
			expect(text(join(repository, "file.txt"))).toBe("initial\n");

			const second = await runtime.retry(first.id, {
				attemptId: "attempt-2",
				autoStart: false,
				failureReason: "Worker timed out",
			});
			expect(text(join(second.workspace!.path, "file.txt"))).toBe("partial implementation\n");
			expect(second.recoveryContext).toMatchObject({
				originalPrompt: "Implement the scoped repair and run npm test",
				artifact: { changedFiles: ["file.txt"] },
				commandDiagnostics: [
					{
						command: "npm test",
						status: "failed",
						output: "Agent ended before the command completed: Worker timed out",
					},
				],
			});

			await runtime.send(second.id, "Continue the repair");
			for (let index = 0; index < 5; index++) {
				factory.sessions[1]?.emit({
					type: "turn_end",
					message: {
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { total: 0.001 },
						},
					},
				});
			}
			expect(factory.sessions[1]?.steerCalls).toEqual([]);
			expect(factory.sessions[1]?.abortCalls).toBe(0);
			factory.sessions[1]?.complete(
				subagentHandoff({ changedFiles: ["file.txt"], verificationSummary: ["npm test passed"] }),
			);
			await expect(runtime.wait(second.id)).resolves.toMatchObject({ status: "completed" });
			expect(text(join(repository, "file.txt"))).toBe("partial implementation\n");
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("publishes an integrated Artifact before completing the Agent Handoff", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-worktree-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const factory = new FakeSubagentSessionFactory();
		const provider = new GitWorktreeWorkspaceProvider({
			baseDirectory: join(root, "workspaces"),
			artifactDirectory: join(root, "artifacts"),
			createId: () => "runtime",
		});
		const runtime = new SubagentRuntime({
			sessionFactory: factory,
			workspaceProvider: provider,
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		try {
			const agent = await runtime.spawn(spawnInput(repository));
			writeFileSync(join(agent.workspace!.path, "file.txt"), "runtime result\n", "utf8");
			await runtime.send(agent.id, "Implement in the isolated Worktree");
			factory.sessions[0]?.complete(
				subagentHandoff({
					changedFiles: ["model-reported-file.txt"],
					verificationSummary: ["Agent verification"],
				}),
			);

			const result = await runtime.wait(agent.id);

			expect(result).toMatchObject({
				status: "completed",
				artifact: {
					status: "integrated",
					changedFiles: ["file.txt"],
				},
				handoff: {
					changedFiles: ["file.txt"],
				},
			});
			expect(text(join(repository, "file.txt"))).toBe("runtime result\n");
			expect(runtime.get(agent.id)?.artifact?.status).toBe("integrated");
			await runtime.release(agent.id);
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records a failed Artifact and does not complete when the integration baseline changed", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-worktree-conflict-"));
		const repository = join(root, "repository");
		execFileSync("git", ["init", repository], { windowsHide: true });
		initializeRepository(repository);
		const factory = new FakeSubagentSessionFactory();
		const runtime = new SubagentRuntime({
			sessionFactory: factory,
			workspaceProvider: new GitWorktreeWorkspaceProvider({
				baseDirectory: join(root, "workspaces"),
				artifactDirectory: join(root, "artifacts"),
			}),
			writerLeaseRegistry: new WriterLeaseRegistry(),
			runtimeRegistry: new WorkflowRuntimeRegistry(),
		});
		try {
			const agent = await runtime.spawn(spawnInput(repository));
			writeFileSync(join(agent.workspace!.path, "file.txt"), "agent result\n", "utf8");
			await runtime.send(agent.id, "Implement in the isolated Worktree");
			writeFileSync(join(repository, "file.txt"), "external result\n", "utf8");
			factory.sessions[0]?.complete(subagentHandoff());

			const result = await runtime.wait(agent.id);

			expect(result).toMatchObject({
				status: "failed",
				artifact: {
					status: "failed",
				},
			});
			expect(text(join(repository, "file.txt"))).toBe("external result\n");
			expect(runtime.get(agent.id)?.artifact?.status).toBe("failed");
			await runtime.release(agent.id);
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
