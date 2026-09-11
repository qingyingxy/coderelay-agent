import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workspace = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT)$/i.test(key)));
Object.assign(env, { PYTHONPATH: join(workspace, 'src'), PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', MEMORY_ASSISTANT_ENV_FILE: join(output, 'empty.env'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' });
writeFileSync(env.MEMORY_ASSISTANT_ENV_FILE, '');
const python = 'E:/code/Memory-RAG/.venv/Scripts/python.exe';
const identity = spawnSync(python, ['-c', 'import memory_assistant; print(memory_assistant.__file__)'], { cwd: workspace, env, encoding: 'utf8', windowsHide: true });
if (!identity.stdout?.toLowerCase().includes(workspace.toLowerCase())) throw new Error('Wrong source import: '+identity.stdout+identity.stderr);
const result = spawnSync(python, ['-m', 'pytest', ...(process.argv.includes('--http-only') ? [] : ['tests', '--ignore=tests/test_organization_permissions.py']), resolve('packages/coding-agent/evals/cost-matrix/test_memory_http.py'), '-v', '--tb=short', '--basetemp', join(output, 'tmp'), '-p', 'no:cacheprovider'], { cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
writeFileSync(join(output, 'pytest.txt'), `${identity.stdout}${result.stdout || ''}${result.stderr || ''}${result.error || ''}`);
writeFileSync(join(output, 'results.json'), JSON.stringify({ exitCode: result.status, passed: result.status === 0, source: identity.stdout.trim(), error: result.error?.message }, null, 2));
console.log(result.stdout, result.stderr, result.error || '');
process.exitCode = result.status === 0 ? 0 : 1;
