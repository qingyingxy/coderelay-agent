import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnProcessSync } from "../../utils/child-process.ts";
import type { Task } from "../workflow/types.ts";
import type { DeliveryDiff, DeliveryFileDiff, DeliveryFileOwner } from "./types.ts";

export interface DiffCollectorOptions {
	readonly maxPatchBytes?: number;
}

function normalizeCandidate(cwd: string, path: string): string | undefined {
	const absolute = resolve(cwd, path);
	const scoped = relative(cwd, absolute).replaceAll("\\", "/");
	return scoped && scoped !== ".." && !scoped.startsWith("../") && !isAbsolute(scoped) ? scoped : undefined;
}

function addedFilePatch(path: string, content: string): string {
	const lines = content.split(/\r?\n/).map((line) => `+${line}`);
	return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, ...lines].join(
		"\n",
	);
}

export class DiffCollector {
	readonly #maxPatchBytes: number;

	constructor(options: DiffCollectorOptions = {}) {
		this.#maxPatchBytes = options.maxPatchBytes ?? 256 * 1024;
	}

	collect(cwd: string, tasks: readonly Task[]): DeliveryDiff {
		const candidates = new Set<string>();
		const ownersByPath = new Map<string, DeliveryFileOwner[]>();
		for (const task of tasks) {
			for (const rawPath of [...task.modifications.map(({ path }) => path), ...(task.result?.changedFiles ?? [])]) {
				const path = normalizeCandidate(cwd, rawPath);
				if (!path) continue;
				candidates.add(path);
				const modifications = task.modifications.filter(
					(modification) => normalizeCandidate(cwd, modification.path) === path,
				);
				const owner: DeliveryFileOwner = {
					taskId: task.id,
					attemptId: modifications.at(-1)?.attemptId ?? task.currentAttemptId,
					agentId: modifications.at(-1)?.agentId ?? task.assignment?.agentId,
					operations: [...new Set(modifications.map(({ operation }) => operation))],
				};
				const existing = ownersByPath.get(path) ?? [];
				if (!existing.some(({ taskId }) => taskId === task.id)) {
					existing.push(owner);
					ownersByPath.set(path, existing);
				}
			}
		}
		const files: DeliveryFileDiff[] = [];
		for (const path of candidates) {
			const tracked = spawnProcessSync("git", ["ls-files", "--error-unmatch", "--", path], {
				cwd,
				encoding: "utf8",
				windowsHide: true,
			});
			let patch = "";
			if (tracked.status === 0) {
				const diff = spawnProcessSync("git", ["diff", "HEAD", "--no-ext-diff", "--", path], {
					cwd,
					encoding: "utf8",
					windowsHide: true,
				});
				patch = diff.stdout;
			} else {
				const absolute = resolve(cwd, path);
				if (existsSync(absolute) && statSync(absolute).isFile()) {
					patch = addedFilePatch(path, readFileSync(absolute, "utf8"));
				}
			}
			const bytes = Buffer.byteLength(patch);
			const truncated = bytes > this.#maxPatchBytes;
			files.push({
				path,
				patch: truncated ? Buffer.from(patch).subarray(0, this.#maxPatchBytes).toString("utf8") : patch,
				owners: ownersByPath.get(path) ?? [],
				truncated,
			});
		}
		const changedFiles = files.map(({ path }) => path);
		return {
			files,
			changedFiles,
			summary: `${changedFiles.length} scoped file${changedFiles.length === 1 ? "" : "s"} changed`,
			evidenceRefs: files.map(({ path }) => `diff:${path}`),
		};
	}
}
