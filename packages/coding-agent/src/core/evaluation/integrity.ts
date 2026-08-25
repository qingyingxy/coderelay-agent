import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function filesWithin(root: string, directory: string): readonly string[] {
	const files: string[] = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			files.push(...filesWithin(root, path));
		} else {
			files.push(path);
		}
	}
	return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export function digestProtectedPaths(root: string, protectedPaths: readonly string[]): string {
	const hash = createHash("sha256");
	for (const protectedPath of [...protectedPaths].sort()) {
		const absolutePath = resolve(root, protectedPath);
		if (!existsSync(absolutePath)) {
			hash.update(protectedPath);
			hash.update("\0missing\0");
			continue;
		}
		const paths = statSync(absolutePath).isDirectory() ? filesWithin(root, absolutePath) : [absolutePath];
		for (const path of paths) {
			hash.update(relative(root, path).replaceAll("\\", "/"));
			hash.update("\0");
			hash.update(readFileSync(path));
			hash.update("\0");
		}
	}
	return `sha256:${hash.digest("hex")}`;
}
