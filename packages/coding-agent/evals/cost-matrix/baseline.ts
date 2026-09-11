import { cpSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureScopedDeliveryBaseline } from "../../src/core/delivery/baseline.ts";

// Dependencies are read-only and outside the delivery diff. Capture source in a
// disposable mirror so neither the original dependency link nor source is altered.
export function captureEvaluationBaseline(workspace: string, workflowId: string, roots: readonly string[], frontend: string) {
  const mirror = mkdtempSync(join(tmpdir(), "matrix-baseline-"));
  const dependencyLink = resolve(workspace, frontend, "node_modules");
  try {
    cpSync(workspace, mirror, { recursive: true, filter: path => {
      if (resolve(path) === dependencyLink) return false;
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Baseline scope contains a symbolic link: ${path}`);
      return true;
    } });
    return { ...captureScopedDeliveryBaseline(mirror, workflowId, roots), cwd: resolve(workspace) };
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}
