import { resolve } from "node:path";

export function isWithinWorkspace(workspace, candidate) {
	const root = resolve(workspace);
	const target = resolve(candidate);
	return target.startsWith(root);
}
