import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import { SUBAGENT_PATH_POLICY_ENV } from "../subagents/enforcement-plan.ts";

const NARROW_NO_BREAK_SPACE = "\u202F";

interface SubagentPathPolicy {
	readonly readableRoots: readonly string[];
	readonly writableRoots: readonly string[];
	readonly deniedRoots: readonly string[];
	readonly writeDeniedRoots: readonly string[];
	readonly denyAll: boolean;
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function subagentPathPolicy(): SubagentPathPolicy | undefined {
	const serialized = process.env[SUBAGENT_PATH_POLICY_ENV];
	if (!serialized) {
		return undefined;
	}
	try {
		const value: unknown = JSON.parse(serialized);
		if (typeof value !== "object" || value === null) {
			throw new Error("Path policy must be an object");
		}
		const record = value as Record<string, unknown>;
		return {
			readableRoots: stringArray(record.readableRoots),
			writableRoots: stringArray(record.writableRoots),
			deniedRoots: stringArray(record.deniedRoots),
			writeDeniedRoots: stringArray(record.writeDeniedRoots),
			denyAll: record.denyAll === true,
		};
	} catch {
		throw new Error(`Invalid ${SUBAGENT_PATH_POLICY_ENV} configuration`);
	}
}

function canonicalPath(path: string): string {
	let existing = resolve(path);
	const missingSegments: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) {
			break;
		}
		missingSegments.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
		existing = parent;
	}
	const canonicalExisting = existsSync(existing) ? realpathSync.native(existing) : existing;
	return resolve(canonicalExisting, ...missingSegments);
}

function pathContains(parent: string, child: string): boolean {
	const relativePath = relative(canonicalPath(parent), canonicalPath(child));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function enforceSubagentPathPolicy(path: string, access: "read" | "write"): void {
	const policy = subagentPathPolicy();
	if (!policy) {
		return;
	}
	if (policy.denyAll) {
		throw new Error(`Subagent filesystem policy denies all paths: ${path}`);
	}
	if (policy.deniedRoots.some((root) => pathContains(root, path))) {
		throw new Error(`Subagent filesystem policy denied path: ${path}`);
	}
	if (access === "write" && policy.writeDeniedRoots.some((root) => pathContains(root, path))) {
		throw new Error(`Subagent filesystem policy denied write path: ${path}`);
	}
	const allowedRoots = access === "write" ? policy.writableRoots : policy.readableRoots;
	if (allowedRoots.length > 0 && !allowedRoots.some((root) => pathContains(root, path))) {
		throw new Error(`Subagent filesystem policy blocked path outside allowed roots: ${path}`);
	}
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const path = resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
	enforceSubagentPathPolicy(path, "read");
	return path;
}

export function resolveWritePath(filePath: string, cwd: string): string {
	const path = resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
	enforceSubagentPathPolicy(path, "write");
	return path;
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	if (await pathExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}
