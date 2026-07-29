import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { isWithinWorkspace } from "../src/path-guard.mjs";

test("accepts a nested path", () => {
	const root = join(process.cwd(), "workspace");
	assert.equal(isWithinWorkspace(root, join(root, "src", "file.ts")), true);
});

test("rejects a sibling with the same string prefix", () => {
	const root = join(process.cwd(), "workspace");
	assert.equal(isWithinWorkspace(root, join(`${root}-backup`, "secret.txt")), false);
});
