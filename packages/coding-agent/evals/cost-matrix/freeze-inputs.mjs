import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const source = resolve('.artifacts/conversation-cost-matrix-v1');
const target = resolve('.artifacts/conversation-cost-matrix-v2');
const tasks = JSON.parse(readFileSync('packages/coding-agent/evals/cost-matrix/tasks.json', 'utf8'));
assert.ok(!existsSync(target), 'Never overwrite a frozen comparison');
const json = path => JSON.parse(readFileSync(join(source, path), 'utf8'));
assert.equal(json('jobflow-followup-dialogs/final-positive/results.json').stats.expected, 8);
assert.equal(json('jobflow-followup-dialogs/final-positive/results.json').stats.unexpected, 0);
assert.equal(json('jobflow-followup-dialogs/final-baseline/results.json').stats.unexpected, 8);
assert.equal(json('live-state-pagination/check-positive/results.json').passed, true);
assert.equal(json('live-state-pagination/check-baseline/results.json').passed, false);
assert.equal(json('memory-organization/final-positive/results.json').passed, true);
assert.equal(json('memory-organization/final-baseline/results.json').passed, false);
assert.equal(json('memory-organization/ui-positive/results.json').passed, true);
assert.equal(json('memory-organization/ui-baseline/results.json').passed, false);
const skip = new Set(['node_modules', '.git', '.pi', '.venv', '__pycache__', '.pytest_cache', '.next', '.artifacts', 'test-results', 'playwright-report', 'data', 'coverage']);
const hash = data => createHash('sha256').update(data).digest('hex');
function copyTree(from, to, prefix = '', manifest = {}) {
  for (const entry of readdirSync(from, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    if (skip.has(entry.name) || entry.isSymbolicLink() || entry.name === '.env' || entry.name.endsWith('.tsbuildinfo')) continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name), path + '/', manifest);
    else {
      mkdirSync(to, { recursive: true });
      const original = readFileSync(join(from, entry.name));
      copyFileSync(join(from, entry.name), join(to, entry.name));
      assert.equal(hash(readFileSync(join(to, entry.name))), hash(original));
      assert.equal(hash(readFileSync(join(from, entry.name))), hash(original), 'Concurrent source mutation');
      manifest[path] = hash(original);
    }
  }
  return manifest;
}
mkdirSync(target, { recursive: true });
const inputs = {};
for (const task of tasks.tasks) {
  const root = join(target, 'tasks', task.id);
  const baseline = join(source, task.id, 'baseline');
  const baselineHashes = copyTree(baseline, join(root, 'baseline'));
  const positiveHashes = copyTree(join(source, task.id, 'positive'), join(target, 'host-only-reference', task.id));
  for (const arm of tasks.arms) {
    const actual = copyTree(baseline, join(root, 'arms', arm, 'workspace'));
    assert.deepEqual(actual, baselineHashes, 'Initial inputs differ');
  }
  inputs[task.id] = { baselineHashes, positiveHashes, baselineDigest: hash(JSON.stringify(baselineHashes)), arms: tasks.arms };
}
const framework = join(target, 'framework');
const frameworkHashes = {};
for (const pkg of ['ai', 'agent', 'tui', 'coding-agent', 'storage']) {
  const root = `packages/${pkg}`;
  const copied = copyTree(root, join(framework, root));
  for (const [path, value] of Object.entries(copied)) frameworkHashes[`${root}/${path}`] = value;
}
for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'vitest.base.ts']) {
  mkdirSync(dirname(join(framework, path)), { recursive: true });
  copyFileSync(path, join(framework, path));
  frameworkHashes[path] = hash(readFileSync(path));
}
const acceptanceHashes = copyTree('packages/coding-agent/evals/cost-matrix', join(target, 'common-acceptance'));
const evidence = {};
for (const [id, dirs] of Object.entries({
  'jobflow-followup-dialogs': ['final-positive', 'final-baseline'],
  'live-state-pagination': ['check-positive', 'check-baseline'],
  'memory-organization': ['final-positive', 'final-baseline', 'ui-positive', 'ui-baseline'],
})) {
  for (const dir of dirs) {
    for (const name of ['results.json', 'pytest.txt', 'backend.txt', 'regression.txt']) {
      const path = join(source, id, dir, name);
      if (!existsSync(path)) continue;
      const destination = join(target, 'evidence', id, dir, name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
      evidence[`${id}/${dir}/${name}`] = hash(readFileSync(path));
    }
  }
}
const manifest = { version: tasks.version, createdAt: new Date().toISOString(), node: process.version, paidCalls: 0,
  status: 'inputs-frozen-not-paid-launch-ready', tasks, inputs, frameworkHashes, acceptanceHashes, evidence,
  frameworkDigest: hash(JSON.stringify(frameworkHashes)),
  dependencyPolicy: 'No installs. Existing local dependency runtimes used in preflight; snapshot source and lockfiles only. Revalidate runtime and rates before paid launch.',
  remainingLaunchGates: ['Generalize the existing live-only driver and tool boundary for these three tasks; preserve frozen task and acceptance hashes.', 'Use faux providers to verify read/write restrictions, host test dispatch, repair and review evidence for each task.', 'Freeze runnable launcher and installed runtime/rate identities before paid launch. No new business features.'],
};
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(target, 'manifest.sha256'), hash(readFileSync(join(target, 'manifest.json'))) + '\n');
console.log(JSON.stringify({ target, frameworkDigest: manifest.frameworkDigest, tasks: Object.keys(inputs), workspaces: 9, paidCalls: 0 }));
