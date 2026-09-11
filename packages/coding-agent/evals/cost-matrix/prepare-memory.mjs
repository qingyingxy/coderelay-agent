import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = 'E:/code/Memory-RAG';
const root = resolve('.artifacts/conversation-cost-matrix-v1/memory-organization');
assert.ok(!existsSync(root), 'Refuse to overwrite prepared evidence');
mkdirSync(root, { recursive: true });
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${repository}`, '-C', repository, ...args]);
const refs = {};
for (const [arm, ref] of [['baseline', '8d436b2^'], ['positive', '8d436b2']]) {
  const workspace = join(root, arm);
  mkdirSync(workspace);
  refs[arm] = git('rev-parse', ref).toString().trim();
  const archive = join(root, `${arm}.zip`);
  git('archive', '--format=zip', `--output=${archive}`, ref);
  execFileSync('tar', ['-xf', archive, '-C', workspace]);
  writeFileSync(join(workspace, 'tests/test_organization_permissions.py'), git('show', '8d436b2:tests/test_organization_permissions.py'));
}
writeFileSync(join(root, 'refs.json'), JSON.stringify(refs, null, 2));
console.log(refs);
