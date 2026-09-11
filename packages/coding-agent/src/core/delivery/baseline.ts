import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SessionManager } from "../session-manager.ts";

export interface DeliveryBaselineFile {
	readonly path: string;
	/** null means the path was absent; undefined means its content is unknown. */
	readonly content?: string | null;
	readonly unavailableReason?: string;
}

export interface DeliveryBaseline {
	readonly version: 1;
	readonly workflowId: string;
	readonly cwd: string;
	readonly files: readonly DeliveryBaselineFile[];
	/** Fully enumerated directories; missing descendants were absent before execution. */
	readonly directories?: readonly string[];
}

export const DELIVERY_BASELINE_ENTRY = "delivery-baseline";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BASELINE_BYTES = 8 * MAX_FILE_BYTES;

export function normalizeDeliveryPath(cwd: string, path: string): string | undefined {
	const scoped = relative(cwd, resolve(cwd, path)).replaceAll("\\", "/");
	return scoped && scoped !== ".." && !scoped.startsWith("../") && !isAbsolute(scoped) ? scoped : undefined;
}

export function readDeliveryFile(cwd: string, path: string): string | null {
	const absolute = resolve(cwd, path);
	try {
		const stat = statSync(absolute);
		if (!normalizeDeliveryPath(realpathSync(cwd), realpathSync(absolute))) {
			throw new Error("File resolves outside the workspace");
		}
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
			throw new Error("Diff requires a regular text file of at most 1 MiB");
		}
		const content = readFileSync(absolute);
		if (content.includes(0)) throw new Error("Binary diff is unavailable");
		return content.toString("utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export function captureDeliveryBaseline(cwd: string, workflowId: string, paths: readonly string[]): DeliveryBaseline {
	let bytes = 0;
	const files = [
		...new Set(paths.map((path) => normalizeDeliveryPath(cwd, path)).filter((path) => path !== undefined)),
	].map((path): DeliveryBaselineFile => {
		try {
			const content = readDeliveryFile(cwd, path);
			bytes += Buffer.byteLength(content ?? "");
			if (bytes > MAX_BASELINE_BYTES) throw new Error("Delivery baseline exceeds 8 MiB");
			return { path, content };
		} catch (error) {
			return { path, unavailableReason: error instanceof Error ? error.message : String(error) };
		}
	});
	return { version: 1, workflowId, cwd: resolve(cwd), files };
}

/** Called by the host with its authorized source roots, never with model-supplied scope. */
export function captureScopedDeliveryBaseline(
	cwd: string,
	workflowId: string,
	roots: readonly string[],
): DeliveryBaseline {
	const paths: string[] = [];
	const directories: string[] = [];
	function visit(path: string): void {
		const absolute = resolve(cwd, path);
		const stat = lstatSync(absolute);
		if (stat.isSymbolicLink()) throw new Error(`Baseline scope contains a symbolic link: ${path}`);
		if (!normalizeDeliveryPath(realpathSync(cwd), realpathSync(absolute))) {
			throw new Error(`Baseline scope escapes workspace: ${path}`);
		}
		if (stat.isDirectory()) {
			for (const entry of readdirSync(absolute).sort()) visit(`${path}/${entry}`);
			directories.push(path);
		} else {
			paths.push(path);
		}
	}
	for (const root of roots) {
		const path = normalizeDeliveryPath(cwd, root);
		if (!path) throw new Error(`Invalid baseline scope: ${root}`);
		visit(path);
	}
	return { ...captureDeliveryBaseline(cwd, workflowId, paths), directories: [...new Set(directories)] };
}

export function readDeliveryBaseline(
	session: SessionManager,
	workflowId: string,
	cwd: string,
): DeliveryBaseline | undefined {
	for (const entry of session.getBranch().reverse()) {
		if (entry.type !== "custom" || entry.customType !== DELIVERY_BASELINE_ENTRY) continue;
		const data: unknown = entry.data;
		if (!data || typeof data !== "object" || !("workflowId" in data) || data.workflowId !== workflowId) continue;
		if (
			!("version" in data) ||
			data.version !== 1 ||
			!("cwd" in data) ||
			data.cwd !== resolve(cwd) ||
			!("files" in data) ||
			!Array.isArray(data.files)
		)
			return undefined;
		const files: DeliveryBaselineFile[] = [];
		for (const file of data.files as unknown[]) {
			if (!file || typeof file !== "object" || !("path" in file) || typeof file.path !== "string") return undefined;
			const content = "content" in file ? file.content : undefined;
			const unavailableReason = "unavailableReason" in file ? file.unavailableReason : undefined;
			if (content !== undefined && content !== null && typeof content !== "string") return undefined;
			if (unavailableReason !== undefined && typeof unavailableReason !== "string") return undefined;
			files.push({ path: file.path, content, unavailableReason });
		}
		const directories = "directories" in data ? data.directories : undefined;
		if (
			directories !== undefined &&
			(!Array.isArray(directories) ||
				directories.some((path: unknown) => typeof path !== "string" || normalizeDeliveryPath(cwd, path) !== path))
		)
			return undefined;
		return { version: 1, workflowId, cwd: resolve(cwd), files, ...(directories ? { directories } : {}) };
	}
	return undefined;
}
