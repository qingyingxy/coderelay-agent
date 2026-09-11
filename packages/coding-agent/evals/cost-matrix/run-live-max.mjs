import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const framework = resolve(process.argv[2]);
const mode = process.argv[3];
const arm = process.argv[4] ?? 'luna';
assert.ok(['sol', 'luna'].includes(arm));
assert.ok(['--preflight', '--run-paid'].includes(mode));
const original = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
const provider = JSON.parse(readFileSync(join(original, 'models.json'), 'utf8')).providers.qingyingxy;
const auth = JSON.parse(readFileSync(join(original, 'auth.json'), 'utf8')).qingyingxy;
assert.equal(auth.type, 'api_key');
assert.ok(auth.key);
const isolated = mkdtempSync(join(tmpdir(), 'pi-live-max-'));
try {
  const models = provider.models.filter(model => ['gpt-5.6-sol', 'gpt-5.6-luna'].includes(model.id)).map(model => ({
    ...model, thinkingLevelMap: { ...model.thinkingLevelMap, ...(model.id === 'gpt-5.6-luna' ? { max: 'max' } : {}) },
  }));
  assert.equal(models.length, 2);
  writeFileSync(join(isolated, 'models.json'), JSON.stringify({ providers: { qingyingxy: { ...provider, apiKey: '$PI_MATRIX_PROVIDER_KEY', models } } }));
  const child = spawn(process.execPath, [join(framework, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(framework, 'tsconfig.json'), join(framework, 'packages/coding-agent/evals/cost-matrix/run-comparison.ts'), mode, 'live-state-pagination', ...(mode === '--run-paid' ? [arm] : [])], {
    cwd: framework, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, PI_CODING_AGENT_DIR: isolated, PI_MATRIX_PROVIDER_KEY: auth.key },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally {
  // Only remove the unique directory created by this invocation; it contains no stored key.
  rmSync(isolated, { recursive: true, force: true });
}
