import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const output = resolve('.artifacts/conversation-cost-matrix-v1');
const tasks = JSON.parse(readFileSync('packages/coding-agent/evals/cost-matrix/tasks.json', 'utf8'));
assert.ok(!existsSync(output), 'Never overwrite an existing trial');
mkdirSync(output, { recursive: true });
const manifests = {};
const sha = data => createHash('sha256').update(data).digest('hex');
function hashes(root, prefix = '') {
  const result = {};
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isSymbolicLink() || ['node_modules', '__pycache__', '.next', 'test-results', 'playwright-report'].includes(e.name)) continue;
    const path = prefix + e.name;
    if (e.isDirectory()) Object.assign(result, hashes(join(root, e.name), path + '/'));
    else result[path] = sha(readFileSync(join(root, e.name)));
  }
  return result;
}
for (const task of tasks.tasks) {
  const git = (...args) => execFileSync('git', ['-c', `safe.directory=${task.repository}`, '-C', task.repository, ...args]);
  const ref = git('rev-parse', task.baseline).toString().trim();
  const paths = task.id.startsWith('live-') ? ['Tools/LiveCommentBridge', 'Tools/LiveOcrBridge', 'Tools/KuaishouLiveBridge', 'Tools/XiaohongshuLiveBridge', 'Tools/DouyinLiveBridge'] : ['frontend'];
  const root = join(output, task.id);
  mkdirSync(root);
  const zip = join(root, 'baseline.zip');
  git('archive', '--format=zip', `--output=${zip}`, ref, ...paths);
  for (const arm of ['baseline', 'positive']) {
    const workspace = join(root, arm);
    mkdirSync(workspace);
    execFileSync('tar', ['-xf', zip, '-C', workspace]);
    const desktop = task.id.startsWith('live-') ? 'Tools/LiveCommentBridge/desktop' : 'frontend';
    symlinkSync(join(task.repository, desktop, 'node_modules'), join(workspace, desktop, 'node_modules'), 'junction');
    if (arm === 'positive') {
      if (task.id === 'jobflow-followup-dialogs') {
        for (const path of ['frontend/app/page.tsx', 'frontend/app/globals.css']) writeFileSync(join(workspace, path), git('show', `1a3b55a:${path}`));
      } else {
        const files = task.id === 'live-request-recovery'
          ? ['Tools/LiveCommentBridge/desktop/electron/main.ts', 'Tools/LiveCommentBridge/desktop/src/stores/dashboard.ts']
          : ['Tools/LiveCommentBridge/ballfight_live_bridge/dashboard_runtime.py', 'Tools/LiveCommentBridge/dashboard_server.py', 'Tools/LiveCommentBridge/desktop/electron/main.ts', 'Tools/LiveCommentBridge/desktop/src/stores/dashboard.ts', 'Tools/LiveCommentBridge/desktop/src/types.ts', 'Tools/LiveCommentBridge/desktop/src/demo.ts', 'Tools/LiveCommentBridge/desktop/src/components/QueueTable.vue', 'Tools/LiveCommentBridge/desktop/src/App.vue'];
        for (const path of files) { assert.ok(existsSync(join(task.repository, path)), path); copyFileSync(join(task.repository, path), join(workspace, path)); }
      }
    }
    if (task.id === 'jobflow-followup-dialogs') {
      for (const name of ['ats-assistance', 'attempts', 'follow-ups', 'packets']) {
        const path = `frontend/e2e/${name}.spec.ts`;
        writeFileSync(join(workspace, path), git('show', `1a3b55a:${path}`));
      }
    }
    manifests[`${task.id}/${arm}`] = { workspace, ref, hashes: hashes(workspace) };
  }
}
writeFileSync(join(output, 'preparation.json'), JSON.stringify({ tasks, manifests, paidCalls: 0, status: 'unsealed, offline acceptance preparation' }, null, 2));
console.log(JSON.stringify({ output, tasks: tasks.tasks.map(t => t.id), paidCalls: 0 }));
