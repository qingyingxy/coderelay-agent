import { resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { spawnProcessSync } from "../../utils/child-process.ts";
import type { Task } from "../workflow/types.ts";
import { type DeliveryBaseline, normalizeDeliveryPath, readDeliveryFile } from "./baseline.ts";
import type { DeliveryDiff, DeliveryFileDiff, DeliveryFileOwner } from "./types.ts";

export interface DiffCollectorOptions {
	readonly maxPatchBytes?: number;
}

export class DiffCollector {
	readonly #maxPatchBytes: number;

	constructor(options: DiffCollectorOptions = {}) {
		this.#maxPatchBytes = options.maxPatchBytes ?? 256 * 1024;
	}

	collect(cwd: string, tasks: readonly Task[], baseline?: DeliveryBaseline): DeliveryDiff {
		const candidates = new Set<string>();
		const ownersByPath = new Map<string, DeliveryFileOwner[]>();
		for (const task of tasks) {
			for (const rawPath of [...task.modifications.map(({ path }) => path), ...(task.result?.changedFiles ?? [])]) {
				const path = normalizeDeliveryPath(cwd, rawPath);
				if (!path) continue;
				candidates.add(path);
				const modifications = task.modifications.filter(
					(modification) => normalizeDeliveryPath(cwd, modification.path) === path,
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
			let patch = "";
			let unavailableReason: string | undefined;
			try {
				if (baseline) {
					if (baseline.cwd !== resolve(cwd) || tasks.some((task) => task.workflowId !== baseline.workflowId)) {
						throw new Error("Delivery baseline belongs to another workspace or Workflow");
					}
					const original =
						baseline.files.find((file) => file.path === path) ??
						(baseline.directories?.some((directory) => path.startsWith(`${directory}/`))
							? { path, content: null }
							: undefined);
					if (!original || original.unavailableReason || original.content === undefined) {
						throw new Error(original?.unavailableReason ?? "No pre-execution baseline for this path");
					}
					const current = readDeliveryFile(cwd, path);
					if (original.content === current) continue;
					patch =
						createTwoFilesPatch(
							original.content === null ? "/dev/null" : `a/${path}`,
							current === null ? "/dev/null" : `b/${path}`,
							original.content ?? "",
							current ?? "",
							undefined,
							undefined,
							{ context: 3, timeout: 1000 },
						) ?? "";
					if (!patch) throw new Error("Diff computation timed out");
				} else {
					const tracked = spawnProcessSync("git", ["ls-files", "--error-unmatch", "--", path], {
						cwd,
						encoding: "utf8",
						windowsHide: true,
					});
					if (tracked.status !== 0) throw new Error("No captured baseline or readable tracked Git baseline");
					const diff = spawnProcessSync("git", ["diff", "HEAD", "--no-ext-diff", "--", path], {
						cwd,
						encoding: "utf8",
						windowsHide: true,
					});
					if (diff.status !== 0) throw new Error("Git baseline diff failed");
					patch = diff.stdout;
				}
			} catch (error) {
				unavailableReason = error instanceof Error ? error.message : String(error);
			}
			const bytes = Buffer.byteLength(patch);
			const truncated = bytes > this.#maxPatchBytes;
			files.push({
				path,
				patch: truncated ? Buffer.from(patch).subarray(0, this.#maxPatchBytes).toString("utf8") : patch,
				owners: ownersByPath.get(path) ?? [],
				truncated,
				unavailableReason,
			});
		}
		const changedFiles = files.map(({ path }) => path);
		return {
			files,
			changedFiles,
			summary: files.some((file) => file.unavailableReason)
				? "Delivery diff unavailable: missing or unreadable baseline"
				: `${changedFiles.length} scoped file${changedFiles.length === 1 ? "" : "s"} changed`,
			evidenceRefs: files.filter((file) => !file.unavailableReason).map(({ path }) => `diff:${path}`),
		};
	}
}
