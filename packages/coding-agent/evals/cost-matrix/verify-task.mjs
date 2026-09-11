import { spawn } from 'node:child_process';
import { closeSync, cpSync, lstatSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const [id, workspaceArg, outputArg] = process.argv.slice(2);
const output = resolve(outputArg);
const adapter = JSON.parse(readFileSync(join(here, 'adapters.json'), 'utf8'))[id];
if (!adapter) throw new Error('Unknown task');
mkdirSync(output, { recursive: true });
// Build tools may generate configuration/cache files. Run them on a disposable copy.
const workspace = join(output, 'workspace');
cpSync(resolve(workspaceArg), workspace, { recursive: true, filter: path => !lstatSync(path).isSymbolicLink() && !path.split(/[\\/]/).some(part => ['node_modules', '.next', '.pi', '.git', '__pycache__', '.pytest_cache'].includes(part)) });
symlinkSync(adapter.dependencyRoots[0], join(workspace, adapter.frontend, 'node_modules'), 'junction');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|LOCALAPPDATA|APPDATA|USERPROFILE|PLAYWRIGHT_BROWSERS_PATH)$/i.test(key)));
Object.assign(env, { NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_API_URL: adapter.apiUrl || '', MATRIX_EXTERNAL_SERVER: '1', MATRIX_WORKSPACE: workspace, MATRIX_OUTPUT: join(output, 'browser') });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
async function command(name, args) {
  const fd = openSync(join(output, `${name}.txt`), 'w');
  try {
    const child = spawn(process.execPath, args, { env, cwd: resolve(here, '../../../..'), windowsHide: true, stdio: ['ignore', fd, fd] });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} infrastructure timeout`)); }, 300000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); if (signal) reject(new Error(`${name} terminated: ${signal}`)); else resolve(code); });
    });
  } finally { closeSync(fd); }
}
let server;
let serverExit;
let serverFd;
let result = { passed: false, infrastructureComplete: false, task: id };
try {
  if (id === 'live-state-pagination') {
    const code = await command('live', [join(here, 'verify-pagination.mjs'), workspace, join(output, 'live')]);
    const detail = read(join(output, 'live/results.json'));
    result = { ...result, passed: code === 0 && detail.passed, infrastructureComplete: detail.browser?.length === 5 && /Ran 6 tests/.test(detail.backend.summary) && /Ran 59 tests/.test(readFileSync(join(output, 'live/regression.txt'), 'utf8')), detail };
  } else {
    let backend;
    if (id === 'memory-organization') {
      await command('backend', [join(here, 'verify-memory.mjs'), workspace, join(output, 'backend')]);
      backend = read(join(output, 'backend/results.json'));
    }
    serverFd = openSync(join(output, 'server.txt'), 'w');
    server = spawn(process.execPath, [join(here, 'serve-next.cjs'), join(workspace, adapter.frontend), String(adapter.port)], { env, windowsHide: true, stdio: ['ignore', serverFd, serverFd, 'ipc'] });
    serverExit = new Promise(resolve => server.once('close', code => resolve(code)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Frontend startup timeout')), 120000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Frontend exited before ready: ${code}`)); });
      server.once('message', message => { if (message?.ready === adapter.port) { clearTimeout(timer); resolve(); } });
    });
    for (const path of id === 'memory-organization' ? ['/login', '/chat', '/organization'] : ['/']) {
      const response = await fetch(`http://localhost:${adapter.port}${path}`, { signal: AbortSignal.timeout(120000) });
      await response.arrayBuffer();
    }
    const code = id === 'memory-organization'
      ? await command('browser', [join(here, 'verify-memory-ui.mjs'), env.MATRIX_OUTPUT])
      : await command('browser', ['E:/code/jobflow-agent/frontend/node_modules/@playwright/test/cli.js', 'test', '--config', join(here, 'jobflow.config.mjs')]);
    const browser = read(join(output, 'browser/results.json'));
    const complete = id === 'memory-organization'
      ? browser.results?.length === 2 && /collected 89 items/.test(readFileSync(join(output, 'backend/pytest.txt'), 'utf8')) && [0, 1].includes(backend.exitCode)
      : browser.stats && browser.stats.expected + browser.stats.unexpected === 8 && browser.stats.skipped === 0 && browser.stats.flaky === 0 && browser.errors.length === 0;
    result = { ...result, infrastructureComplete: Boolean(complete), passed: code === 0 && (!backend || backend.passed), backend, browser };
  }
} catch (error) { result.error = error.message; }
finally {
  if (server) {
    if (server.connected) server.send('shutdown');
    const timer = setTimeout(() => server.kill(), 15000);
    const exitCode = await serverExit;
    clearTimeout(timer);
    result.serverExitCode = exitCode;
    if (exitCode !== 0) { result.infrastructureComplete = false; result.error = 'Frontend did not shut down cleanly'; }
  }
  if (serverFd !== undefined) closeSync(serverFd);
}
result.passed = result.passed && result.infrastructureComplete;
writeFileSync(join(output, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ task: id, passed: result.passed, infrastructureComplete: result.infrastructureComplete, error: result.error }));
process.exitCode = result.infrastructureComplete ? (result.passed ? 0 : 1) : 2;
