import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const repo = resolve('.');
const previous = join(repo, '.artifacts/conversation-cost-matrix-v2');
const liveMax = process.argv.includes('--live-max');
const target = join(repo, liveMax ? '.artifacts/conversation-cost-matrix-v6-live-max' : '.artifacts/conversation-cost-matrix-v5');
const source = join(repo, 'packages/coding-agent/evals/cost-matrix');
const digest = data => createHash('sha256').update(data).digest('hex');
const old = JSON.parse(readFileSync(join(previous, 'manifest.json'), 'utf8'));
assert.equal(digest(readFileSync(join(previous, 'manifest.json'))), readFileSync(join(previous, 'manifest.sha256'), 'utf8').trim());
assert.ok(!existsSync(target), 'Refuse to overwrite a frozen trial');
const adapters = JSON.parse(readFileSync(join(source, 'adapters.json'), 'utf8'));
for (const name of ['test_memory_http.py', 'test_pagination.py', 'verify-memory.mjs', 'verify-memory-ui.mjs', 'verify-pagination.mjs', 'jobflow.config.mjs']) {
  if (liveMax && name === 'verify-pagination.mjs') continue; // Revised browser oracle is separately validated below and frozen.
  assert.equal(digest(readFileSync(join(source, name))), old.acceptanceHashes[name], `Acceptance changed: ${name}`);
}
for (const name of liveMax ? [] : ['jobflow-final', 'memory-final', 'live-catalog-restored']) {
  const result = JSON.parse(readFileSync(join(repo, '.artifacts/cost-matrix-adapter-preflight', name, 'results.json'), 'utf8'));
  assert.equal(result.passed, true, `Adapter positive control failed: ${name}`);
  assert.equal(result.infrastructureComplete, true);
}
if (liveMax) {
  for (const name of ['positive', 'baseline', 'state-wipe', 'stale-page']) {
    const result = JSON.parse(readFileSync(join(repo, '.artifacts/live-max-preflight', name, 'results.json'), 'utf8'));
    assert.equal(result.infrastructureComplete, true, `Incomplete control: ${name}`);
    assert.equal(result.passed, name === 'positive', `Incorrect oracle result: ${name}`);
    if (name === 'state-wipe') assert.equal(result.detail.browser.find(test => test.name === 'unchanged-poll-preserves-full-state').passed, false);
    if (name === 'stale-page') assert.equal(result.detail.browser.find(test => test.name === 'late-old-page-does-not-overwrite-new-page').passed, false);
  }
}
function hashes(root, prefix = '', result = {}) {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) hashes(join(root, entry.name), name + '/', result);
    else result[name] = digest(readFileSync(join(root, entry.name)));
  }
  return result;
}
mkdirSync(target);
const framework = join(target, 'framework');
cpSync(join(previous, 'framework'), framework, { recursive: true });
for (const [path, hash] of Object.entries(old.frameworkHashes)) assert.equal(digest(readFileSync(join(framework, path))), hash);
cpSync(source, join(framework, 'packages/coding-agent/evals/cost-matrix'), { recursive: true });
copyFileSync(join(repo, 'packages/coding-agent/test/suite/cost-matrix-adapters.test.ts'), join(framework, 'packages/coding-agent/test/suite/cost-matrix-adapters.test.ts'));
if (liveMax) for (const path of ['packages/coding-agent/src/core/subagents/rpc-session.ts', 'packages/coding-agent/test/workflow/rpc-subagent-session.test.ts', 'packages/coding-agent/test/suite/cost-matrix-live-max.test.ts']) {
  copyFileSync(join(repo, path), join(framework, path));
}
const runtimeDataCorrections = {};
for (const path of ['packages/ai/src/providers/data', 'packages/ai/dist/providers/data']) {
  assert.ok(!existsSync(join(framework, path)), `Unexpected existing runtime data: ${path}`);
  cpSync(join(repo, path), join(framework, path), { recursive: true });
  runtimeDataCorrections[path] = hashes(join(framework, path));
}
const matrix = { inputFreeze: old.frameworkDigest, tasks: {}, staticFixtureCorrection: null, runtimeDataCorrections };
const fixturePath = 'Tools/XiaohongshuLiveBridge/data/xiaohongshu_gift_catalog.json';
const fixture = execFileSync('git', ['-c', 'safe.directory=E:/code/ballfightlive-version', '-C', 'E:/code/ballfightlive-version', 'show', `3f324ca2dd5f109f5984ab37dd18c8ded2004396:${fixturePath}`]);
matrix.staticFixtureCorrection = { path: fixturePath, sha256: digest(fixture), reason: 'v2 mistakenly excluded a tracked static data directory; restore identically from the original baseline commit' };
for (const task of old.tasks.tasks.filter(task => !liveMax || task.id === 'live-state-pagination')) {
  const adapter = adapters[task.id];
  const output = join(target, 'tasks', task.id);
  const arms = {};
  let expected;
  for (const arm of liveMax ? ['luna'] : ['sol', 'luna', 'terra']) {
    const workspace = join(output, arm, 'workspace');
    cpSync(join(previous, 'tasks', task.id, 'baseline'), workspace, { recursive: true });
    assert.deepEqual(hashes(workspace), old.inputs[task.id].baselineHashes);
    if (task.id === 'live-state-pagination') {
      mkdirSync(dirname(join(workspace, fixturePath)), { recursive: true });
      writeFileSync(join(workspace, fixturePath), fixture);
    }
    mkdirSync(join(workspace, '.acceptance'));
    for (const name of adapter.acceptanceFiles) copyFileSync(join(source, name), join(workspace, '.acceptance', name));
    const initial = hashes(workspace);
    if (expected) assert.deepEqual(initial, expected);
    expected = initial;
    symlinkSync(adapter.dependencyRoots[0], join(workspace, adapter.frontend, 'node_modules'), 'junction');
    arms[arm] = { workspace, hashes: initial };
  }
  matrix.tasks[task.id] = { objective: task.objective + (liveMax ? '\n' + readFileSync(join(source, 'live-acceptance.md'), 'utf8') : ''), adapter, output, arms };
}
writeFileSync(join(framework, 'matrix.json'), JSON.stringify(matrix, null, 2));
const modules = join(framework, 'node_modules');
mkdirSync(modules);
const dependencies = {};
for (const entry of readdirSync(join(repo, 'node_modules'), { withFileTypes: true })) {
  const actual = join(repo, 'node_modules', entry.name);
  if (entry.name === '@earendil-works') {
    mkdirSync(join(modules, entry.name));
    for (const name of readdirSync(actual)) {
      const path = realpathSync(join(actual, name));
      const frozen = join(framework, relative(repo, path));
      symlinkSync(existsSync(frozen) ? frozen : path, join(modules, entry.name, name), 'junction');
    }
  } else if (statSync(actual).isDirectory()) symlinkSync(actual, join(modules, entry.name), 'junction');
  else copyFileSync(actual, join(modules, entry.name));
}
for (const adapter of Object.values(adapters)) {
  const path = join(adapter.dependencyRoots[0], '.package-lock.json');
  if (existsSync(path)) dependencies[path] = digest(readFileSync(path));
}
const files = hashes(framework);
const manifest = { digest: digest(JSON.stringify(files)), files, node: process.version, dependencies, paidCalls: 0,
  status: 'offline-adapters-verified-awaiting-rate-preflight',
  limitations: ['Existing external dependencies shared; source/lockfile hashes are frozen, not a hermetic environment', 'Tool permissions are not an OS sandbox', 'Configured rate snapshot is produced by --preflight without model requests before any paid arm'] };
writeFileSync(join(framework, 'freeze-manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(target, 'location.json'), JSON.stringify({ framework, digest: manifest.digest, paidCalls: 0 }, null, 2));
console.log(JSON.stringify({ framework, digest: manifest.digest, tasks: Object.keys(matrix.tasks), workspaces: liveMax ? 1 : 9, paidCalls: 0 }));
