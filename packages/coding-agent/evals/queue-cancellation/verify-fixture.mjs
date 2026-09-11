import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../r16/fixtures/queue-cancellation/", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "queue-fixture-check-"));
try {
	cpSync(fixture, workspace, { recursive: true });
	const before = spawnSync(process.execPath, ["--test"], { cwd: workspace, encoding: "utf8", timeout: 15000 });
	assert.equal(before.error, undefined);
	assert.equal(before.status, 1);
	assert.match(before.stdout, /pass 2/);
	assert.match(before.stdout, /fail 7/);
	cpSync(new URL("./reference/queue.mjs", import.meta.url), join(workspace, "src/queue.mjs"));
	const after = spawnSync(process.execPath, ["--test"], { cwd: workspace, encoding: "utf8", timeout: 15000 });
	assert.equal(after.error, undefined);
	assert.equal(after.status, 0, after.stdout + after.stderr);
	assert.match(after.stdout, /pass 9/);
	console.log("Fixture validated: starter 2 passed / 7 failed; reference 9 passed / 0 failed.");
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
