import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { normalizePath } from "../../src/utils/paths.ts";

export interface LiveToolBoundary {
	readonly workspace: string;
	readonly dependencyRoots: readonly string[];
	readonly writable: boolean;
}

function contains(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function liveToolViolation(policy: LiveToolBoundary, tool: string, input: Record<string, unknown>): string | undefined {
	if (["new_context", "history", "notes"].includes(tool)) return undefined;
	const write = tool === "edit" || tool === "write";
	if (!write && !["read", "grep", "find", "ls"].includes(tool)) return "Tool is not allowed; external host owns test execution";
	if (write && !policy.writable) return "Read-only role cannot modify files";
	const requested = input.path ?? (tool === "read" ? input.file_path : undefined) ?? ".";
	if (typeof requested !== "string" || !requested.trim()) return "Invalid path";
	const raw = normalizePath(requested, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
	// Reject Windows device paths, ADS, drive-relative paths and ambiguous aliases.
	if (raw.includes("\0") || raw.startsWith("\\\\") || raw.startsWith("//") || /[<>|]/.test(raw) ||
		/:(?![\\/])/.test(raw) || raw.replace(/^[a-z]:/i, "").includes(":") ||
		raw.split(/[\\/]/).some(part => part !== "." && part !== ".." && /[ .]$/.test(part))) return "Unsupported path syntax";
	const workspace = realpathSync.native(policy.workspace);
	const target = resolve(workspace, raw);
	if (write && relative(workspace, target).split(/[\\/]/).some(part =>
		/^(?:node_modules|\.venv|\.git|\.pi|tests?|package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/i.test(part))) return "Protected test, dependency or configuration path";
	const reads = [workspace, ...policy.dependencyRoots.map(root => realpathSync.native(root))];
	const writes = ["ballfight_live_bridge", "desktop/src", "desktop/electron"].map(path => resolve(workspace, "Tools/LiveCommentBridge", path));
	const roots = write ? writes : reads;
	if (!roots.some(root => contains(root, target))) return "Path outside allowed roots";
	let existing = target;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	const canonical = resolve(realpathSync.native(existing), relative(existing, target));
	if (!roots.some(root => contains(root, canonical))) return "Link escapes allowed roots";
	if (write && existsSync(target) && lstatSync(target).nlink > 1) return "Hard-linked files are not writable";
	return undefined;
}

export function liveBoundaryExtension(policy: LiveToolBoundary): ExtensionFactory {
	const fixed = { ...policy, dependencyRoots: [...policy.dependencyRoots] };
	return pi => {
		pi.on("tool_call", event => {
			const reason = liveToolViolation(fixed, event.toolName, event.input);
			if (reason) return { block: true, reason: `Evaluation boundary: ${reason}` };
			return undefined;
		});
		pi.on("before_agent_start", () => ({
			message: { customType: "evaluation-boundary", content: "Use file tools only. Arbitrary shell commands are blocked. The external host executes the common acceptance tests after implementation and returns evidence if repair is needed. Read only this workspace and necessary dependencies. Do not access other arms or historical answers.", display: false },
		}));
	};
}

export default function extension(pi: Parameters<ExtensionFactory>[0]) {
	const serialized = process.env.PI_LIVE_TOOL_BOUNDARY;
	if (!serialized) throw new Error("Missing mandatory evaluation boundary");
	const policy = JSON.parse(serialized) as LiveToolBoundary;
	if (typeof policy.workspace !== "string" || typeof policy.writable !== "boolean" || !Array.isArray(policy.dependencyRoots)) throw new Error("Invalid evaluation boundary");
	return liveBoundaryExtension(policy)(pi);
}
