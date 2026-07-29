import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentWorkspace, SubagentModification, WorkspaceArtifact } from "./types.ts";
import {
	CurrentWorkspaceProvider,
	type WorkspacePrepareRequest,
	type WorkspaceProvider,
} from "./workspace-provider.ts";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

interface GitWorkspaceMetadata {
	readonly schemaVersion: 1;
	readonly workspace: AgentWorkspace;
	readonly targetRoot: string;
	readonly relativeCwd: string;
	readonly branch: string;
	readonly ownerPid: number;
	readonly createdAt: string;
	readonly baselineFingerprint: string;
	readonly integrationBaseCommit: string;
}

export interface GitWorktreeWorkspaceProviderOptions {
	readonly baseDirectory?: string;
	readonly artifactDirectory?: string;
	readonly createId?: () => string;
	readonly now?: () => number;
	readonly fallback?: WorkspaceProvider;
}

export class GitWorktreeWorkspaceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "GitWorktreeWorkspaceError";
		this.code = code;
	}
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER,
		windowsHide: true,
	});
	return result.stdout;
}

function normalizedIdentity(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function repositoryIdentity(root: string): string {
	return `git:${normalizedIdentity(root)}`;
}

function storageKey(root: string): string {
	return createHash("sha256").update(normalizedIdentity(root)).digest("hex").slice(0, 20);
}

function safeAgentSegment(agentId: string): string {
	const segment = agentId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
	return segment || randomUUID();
}

function isWithin(parent: string, child: string): boolean {
	const relativePath = relative(resolve(parent), resolve(child));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function commandExists(command: string): Promise<boolean> {
	try {
		await execFileAsync(command, ["--version"], { windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

async function untrackedFiles(root: string): Promise<readonly string[]> {
	const output = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	return output.split("\0").filter(Boolean);
}

async function copyUntrackedFiles(sourceRoot: string, targetRoot: string, paths: readonly string[]): Promise<void> {
	for (const path of paths) {
		const source = join(sourceRoot, path);
		const target = join(targetRoot, path);
		const sourceStat = await stat(source);
		if (!sourceStat.isFile()) {
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	}
}

async function workingTreeFingerprint(root: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(await git(root, ["rev-parse", "HEAD"]));
	hash.update(await git(root, ["diff", "--binary", "HEAD", "--", "."]));
	const untracked = await untrackedFiles(root);
	for (const path of [...untracked].sort()) {
		hash.update(path);
		hash.update(await readFile(join(root, path)));
	}
	return hash.digest("hex");
}

async function createInternalCommit(root: string, parent: string, message: string): Promise<string> {
	await git(root, ["add", "--all", "--", "."]);
	const tree = (await git(root, ["write-tree"])).trim();
	const result = await execFileAsync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Pi Subagent",
			"-c",
			"user.email=pi-subagent@localhost",
			"commit-tree",
			tree,
			"-p",
			parent,
			"-m",
			message,
		],
		{ encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
	);
	const commit = result.stdout.trim();
	const branch = (await git(root, ["symbolic-ref", "--short", "HEAD"])).trim();
	await git(root, ["update-ref", `refs/heads/${branch}`, commit, parent]);
	return commit;
}

function processIsActive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid < 1) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

export class GitWorktreeWorkspaceProvider implements WorkspaceProvider {
	readonly #baseDirectory: string;
	readonly #artifactDirectory: string;
	readonly #createId: () => string;
	readonly #now: () => number;
	readonly #fallback: WorkspaceProvider;
	readonly #metadata = new Map<string, GitWorkspaceMetadata>();

	constructor(options: GitWorktreeWorkspaceProviderOptions = {}) {
		this.#baseDirectory = resolve(options.baseDirectory ?? join(tmpdir(), "pi-subagent-worktrees"));
		this.#artifactDirectory = resolve(options.artifactDirectory ?? join(tmpdir(), "pi-subagent-artifacts"));
		this.#createId = options.createId ?? randomUUID;
		this.#now = options.now ?? Date.now;
		this.#fallback = options.fallback ?? new CurrentWorkspaceProvider();
	}

	async prepare(request: WorkspacePrepareRequest): Promise<AgentWorkspace> {
		if (!request.write || !(await commandExists("git"))) {
			return this.#fallback.prepare(request);
		}
		let repositoryRoot: string;
		try {
			repositoryRoot = (await git(request.input.cwd, ["rev-parse", "--show-toplevel"])).trim();
		} catch {
			return this.#fallback.prepare(request);
		}
		const canonicalRoot = await realpath(repositoryRoot);
		const relativeCwd = relative(canonicalRoot, resolve(request.input.cwd));
		if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
			throw new GitWorktreeWorkspaceError(
				"workspace.cwd_outside_repository",
				`Subagent cwd ${request.input.cwd} is outside repository ${canonicalRoot}`,
			);
		}
		const key = storageKey(canonicalRoot);
		const agentSegment = safeAgentSegment(request.agentId);
		const worktreeRoot = join(this.#baseDirectory, key, "worktrees", agentSegment);
		const metadataPath = join(this.#baseDirectory, key, "metadata", `${agentSegment}.json`);
		if (!isWithin(this.#baseDirectory, worktreeRoot) || !isWithin(this.#baseDirectory, metadataPath)) {
			throw new GitWorktreeWorkspaceError(
				"workspace.path_escape",
				"Resolved Worktree path escaped its base directory",
			);
		}
		await mkdir(dirname(worktreeRoot), { recursive: true });
		await mkdir(dirname(metadataPath), { recursive: true });
		const head = (await git(canonicalRoot, ["rev-parse", "HEAD"])).trim();
		const branch = `pi/subagent/${agentSegment}`;
		await execFileAsync("git", ["-C", canonicalRoot, "worktree", "add", "-b", branch, worktreeRoot, head], {
			encoding: "utf8",
			maxBuffer: GIT_MAX_BUFFER,
			windowsHide: true,
		});
		try {
			const baselinePatch = await git(canonicalRoot, ["diff", "--binary", "HEAD", "--", "."]);
			if (baselinePatch) {
				const patchPath = join(dirname(metadataPath), `${agentSegment}.baseline.patch`);
				await writeFile(patchPath, baselinePatch, "utf8");
				await git(worktreeRoot, ["apply", "--binary", patchPath]);
				await rm(patchPath, { force: true });
			}
			await copyUntrackedFiles(canonicalRoot, worktreeRoot, await untrackedFiles(canonicalRoot));
			const baselineCommit = await createInternalCommit(
				worktreeRoot,
				head,
				`Pi Subagent baseline ${request.agentId}`,
			);
			const fingerprint = await workingTreeFingerprint(canonicalRoot);
			const workspace: AgentWorkspace = {
				id: `worktree:${key}:${agentSegment}`,
				path: relativeCwd ? join(worktreeRoot, relativeCwd) : worktreeRoot,
				kind: "git-worktree",
				repositoryIdentity: repositoryIdentity(canonicalRoot),
				repositoryRoot: canonicalRoot,
				baselineCommit,
				resultBranch: branch,
				baselineFingerprint: fingerprint,
				assurance: "isolated",
			};
			const metadata: GitWorkspaceMetadata = {
				schemaVersion: 1,
				workspace,
				targetRoot: canonicalRoot,
				relativeCwd,
				branch,
				ownerPid: process.pid,
				createdAt: new Date(this.#now()).toISOString(),
				baselineFingerprint: fingerprint,
				integrationBaseCommit: baselineCommit,
			};
			await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
			this.#metadata.set(workspace.id, metadata);
			return workspace;
		} catch (error) {
			await execFileAsync("git", ["-C", canonicalRoot, "worktree", "remove", "--force", worktreeRoot], {
				windowsHide: true,
			}).catch(() => undefined);
			await git(canonicalRoot, ["branch", "-D", branch]).catch(() => undefined);
			throw error;
		}
	}

	async createArtifact(
		workspace: AgentWorkspace,
		_modifications: readonly SubagentModification[],
	): Promise<WorkspaceArtifact | undefined> {
		if (workspace.kind !== "git-worktree") {
			return undefined;
		}
		const metadata = await this.#requireMetadata(workspace);
		const worktreeRoot = this.#worktreeRoot(metadata);
		const resultCommit = await createInternalCommit(
			worktreeRoot,
			metadata.integrationBaseCommit,
			`Pi Subagent result ${workspace.id}`,
		);
		const patch = await git(worktreeRoot, [
			"diff",
			"--binary",
			metadata.integrationBaseCommit,
			resultCommit,
			"--",
			".",
		]);
		const changedOutput = await git(worktreeRoot, [
			"diff",
			"--name-only",
			"-z",
			metadata.integrationBaseCommit,
			resultCommit,
			"--",
			".",
		]);
		const artifactId = `artifact-${this.#createId()}`;
		const directory = join(this.#artifactDirectory, storageKey(metadata.targetRoot));
		const patchPath = join(directory, `${safeAgentSegment(artifactId)}.patch`);
		if (!isWithin(this.#artifactDirectory, patchPath)) {
			throw new GitWorktreeWorkspaceError(
				"workspace.artifact_path_escape",
				"Artifact path escaped its base directory",
			);
		}
		await mkdir(directory, { recursive: true });
		await writeFile(patchPath, patch, "utf8");
		const artifact: WorkspaceArtifact = {
			id: artifactId,
			workspaceId: workspace.id,
			repositoryIdentity: workspace.repositoryIdentity ?? repositoryIdentity(metadata.targetRoot),
			baselineCommit: metadata.integrationBaseCommit,
			resultCommit,
			patchPath,
			changedFiles: changedOutput.split("\0").filter(Boolean),
			status: "created",
			createdAt: new Date(this.#now()).toISOString(),
		};
		await writeFile(`${patchPath}.json`, JSON.stringify(artifact, null, 2), "utf8");
		return artifact;
	}

	async integrateArtifact(artifact: WorkspaceArtifact): Promise<WorkspaceArtifact> {
		const metadata = await this.#requireMetadataById(artifact.workspaceId);
		const currentFingerprint = await workingTreeFingerprint(metadata.targetRoot);
		if (currentFingerprint !== metadata.baselineFingerprint) {
			const failed: WorkspaceArtifact = {
				...artifact,
				status: "failed",
				error: "Target repository changed after the Agent Worktree was prepared",
			};
			await writeFile(`${artifact.patchPath}.json`, JSON.stringify(failed, null, 2), "utf8");
			throw new GitWorktreeWorkspaceError(
				"workspace.integration_baseline_changed",
				`Artifact ${artifact.id} cannot be integrated because the target repository changed`,
			);
		}
		const patch = await readFile(artifact.patchPath, "utf8");
		if (patch) {
			await git(metadata.targetRoot, ["apply", "--check", "--binary", artifact.patchPath]);
			await git(metadata.targetRoot, ["apply", "--binary", artifact.patchPath]);
		}
		const integrated: WorkspaceArtifact = {
			...artifact,
			status: "integrated",
			integratedAt: new Date(this.#now()).toISOString(),
		};
		const updatedMetadata: GitWorkspaceMetadata = {
			...metadata,
			baselineFingerprint: await workingTreeFingerprint(metadata.targetRoot),
			integrationBaseCommit: artifact.resultCommit,
		};
		await this.#writeMetadata(updatedMetadata);
		this.#metadata.set(artifact.workspaceId, updatedMetadata);
		await writeFile(`${artifact.patchPath}.json`, JSON.stringify(integrated, null, 2), "utf8");
		return integrated;
	}

	async release(workspace: AgentWorkspace): Promise<void> {
		if (workspace.kind !== "git-worktree") {
			await this.#fallback.release(workspace);
			return;
		}
		const metadata = await this.#metadataFor(workspace);
		if (!metadata) {
			return;
		}
		const worktreeRoot = this.#worktreeRoot(metadata);
		if (!isWithin(this.#baseDirectory, worktreeRoot)) {
			throw new GitWorktreeWorkspaceError("workspace.release_path_escape", "Refused to release an unsafe path");
		}
		try {
			await execFileAsync("git", ["-C", metadata.targetRoot, "worktree", "remove", "--force", worktreeRoot], {
				windowsHide: true,
			});
		} catch (error) {
			if (await this.#directoryExists(worktreeRoot)) {
				throw new GitWorktreeWorkspaceError(
					"workspace.release_failed",
					`Failed to remove Worktree ${worktreeRoot}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			await git(metadata.targetRoot, ["worktree", "prune"]);
		}
		try {
			await git(metadata.targetRoot, ["branch", "-D", metadata.branch]);
		} catch (error) {
			throw new GitWorktreeWorkspaceError(
				"workspace.branch_release_failed",
				`Failed to remove internal branch ${metadata.branch}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await rm(this.#metadataPath(metadata), { force: true });
		this.#metadata.delete(workspace.id);
	}

	async recover(workspaces: readonly AgentWorkspace[]): Promise<void> {
		for (const workspace of workspaces) {
			if (workspace.kind !== "git-worktree") {
				continue;
			}
			const metadata = await this.#metadataFor(workspace);
			if (metadata) {
				this.#metadata.set(workspace.id, metadata);
			}
		}
	}

	async cleanupOrphans(ownedWorkspaceIds: ReadonlySet<string>): Promise<readonly string[]> {
		const cleaned: string[] = [];
		if (!(await this.#directoryExists(this.#baseDirectory))) {
			return cleaned;
		}
		for (const repositoryEntry of await readdir(this.#baseDirectory, { withFileTypes: true })) {
			if (!repositoryEntry.isDirectory()) {
				continue;
			}
			const metadataDirectory = join(this.#baseDirectory, repositoryEntry.name, "metadata");
			if (!(await this.#directoryExists(metadataDirectory))) {
				continue;
			}
			for (const entry of await readdir(metadataDirectory, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) {
					continue;
				}
				const path = join(metadataDirectory, entry.name);
				const metadata = await this.#readMetadata(path);
				if (!metadata || ownedWorkspaceIds.has(metadata.workspace.id) || processIsActive(metadata.ownerPid)) {
					continue;
				}
				await this.release(metadata.workspace);
				cleaned.push(metadata.workspace.id);
			}
		}
		return cleaned;
	}

	#worktreeRoot(metadata: GitWorkspaceMetadata): string {
		return metadata.relativeCwd
			? resolve(metadata.workspace.path, ...metadata.relativeCwd.split(/[\\/]/).map(() => ".."))
			: metadata.workspace.path;
	}

	#metadataPath(metadata: GitWorkspaceMetadata): string {
		const key = storageKey(metadata.targetRoot);
		const agentSegment = metadata.workspace.id.split(":").at(-1) ?? safeAgentSegment(metadata.workspace.id);
		return join(this.#baseDirectory, key, "metadata", `${agentSegment}.json`);
	}

	async #writeMetadata(metadata: GitWorkspaceMetadata): Promise<void> {
		await writeFile(this.#metadataPath(metadata), JSON.stringify(metadata, null, 2), "utf8");
	}

	async #metadataFor(workspace: AgentWorkspace): Promise<GitWorkspaceMetadata | undefined> {
		const cached = this.#metadata.get(workspace.id);
		if (cached) {
			return cached;
		}
		if (!workspace.repositoryRoot) {
			return undefined;
		}
		const key = storageKey(workspace.repositoryRoot);
		const agentSegment = workspace.id.split(":").at(-1) ?? safeAgentSegment(workspace.id);
		return this.#readMetadata(join(this.#baseDirectory, key, "metadata", `${agentSegment}.json`));
	}

	async #requireMetadata(workspace: AgentWorkspace): Promise<GitWorkspaceMetadata> {
		const metadata = await this.#metadataFor(workspace);
		if (!metadata) {
			throw new GitWorktreeWorkspaceError(
				"workspace.metadata_missing",
				`Workspace metadata for ${workspace.id} does not exist`,
			);
		}
		return metadata;
	}

	async #requireMetadataById(workspaceId: string): Promise<GitWorkspaceMetadata> {
		const metadata = this.#metadata.get(workspaceId);
		if (!metadata) {
			throw new GitWorktreeWorkspaceError(
				"workspace.metadata_missing",
				`Workspace metadata for ${workspaceId} does not exist`,
			);
		}
		return metadata;
	}

	async #readMetadata(path: string): Promise<GitWorkspaceMetadata | undefined> {
		try {
			const value: unknown = JSON.parse(await readFile(path, "utf8"));
			if (typeof value !== "object" || value === null || (value as Record<string, unknown>).schemaVersion !== 1) {
				return undefined;
			}
			const metadata = value as GitWorkspaceMetadata;
			if (
				typeof metadata.workspace?.id !== "string" ||
				typeof metadata.workspace?.path !== "string" ||
				typeof metadata.targetRoot !== "string" ||
				typeof metadata.branch !== "string" ||
				typeof metadata.ownerPid !== "number" ||
				typeof metadata.baselineFingerprint !== "string" ||
				typeof metadata.integrationBaseCommit !== "string"
			) {
				return undefined;
			}
			return metadata;
		} catch {
			return undefined;
		}
	}

	async #directoryExists(path: string): Promise<boolean> {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	}
}
