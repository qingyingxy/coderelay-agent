import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createServer } from 'file:///E:/code/ballfightlive-version/Tools/LiveCommentBridge/desktop/node_modules/vite/dist/node/index.js';
import { chromium } from 'file:///E:/code/jobflow-agent/frontend/node_modules/playwright/index.mjs';

const workspace = resolve(process.argv[2]); const output = resolve(process.argv[3]);
mkdirSync(output, { recursive: true });
const results = []; const require = createRequire(import.meta.url);
async function check(name, action) { try { await action(); results.push({ name, passed: true }); } catch(e) { results.push({ name, passed: false, error: e.message }); } }
const source = readFileSync(join(workspace, 'Tools/LiveCommentBridge/desktop/electron/main.ts'), 'utf8');
// Expose the existing private request entry only; execute the actual implementation.
const code = transformSync(source + '\nglobalThis.testRequest = dashboardRequest; globalThis.testConnect = value => { connection = value; };', { loader: 'ts', format: 'cjs' }).code;
const electron = { app: { whenReady: () => ({ then: () => ({ catch() {} }) }), on() {}, requestSingleInstanceLock: () => true, quit() {} }, ipcMain: { handle() {} }, BrowserWindow: class {} };
for (const method of ['GET', 'POST']) {
  await check(`${method}-hanging-fetch-aborts-and-next-request-works`, async () => {
    const timers = []; let signal; let requestNumber = 0;
    const context = vm.createContext({ console, process, Buffer, URL, __dirname: join(workspace, 'Tools/LiveCommentBridge/desktop/electron'), exports: {},
      require: name => name === 'electron' ? electron : require(name),
      setTimeout: (fn, ms) => { const record = { fn, ms }; timers.push(record); return record; }, clearTimeout: timer => { timer.cleared = true; },
      AbortController, AbortSignal: { timeout(ms) { const controller = new AbortController(); timers.push({ ms, fn: () => controller.abort(new DOMException('expired', 'TimeoutError')) }); return controller.signal; } },
      fetch: async (_url, options) => {
        requestNumber++;
        if (requestNumber > 1) return { ok: true, json: async () => ({ ok: true }) };
        signal = options.signal;
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true }));
      },
    });
    vm.runInContext(code, context);
    context.testConnect({ port: 12345, token: 'offline-test' });
    const pending = context.testRequest({ path: method === 'POST' ? '/api/command' : '/api/state', method, body: { action: 'stop' } });
    const rejected = pending.then(() => false, () => true);
    await Promise.resolve();
    assert.ok(signal, 'request must have a cancellation signal');
    const timeout = timers.find(timer => !timer.cleared && timer.ms === (method === 'POST' ? 30000 : 5000));
    assert.ok(timeout, 'state timeout=5s, command timeout=30s'); timeout.fn();
    assert.equal(await rejected, true); assert.equal(signal.aborted, true);
    assert.equal((await context.testRequest({ path: '/api/state' })).ok, true);
  });
}
let server; let browser;
try {
  server = await createServer({ root: join(workspace, 'Tools/LiveCommentBridge/desktop'), configLoader: 'native', cacheDir: join(output, 'vite'), server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [workspace, 'E:/code/ballfightlive-version/Tools/LiveCommentBridge/desktop/node_modules'] } } });
  await server.listen(); browser = await chromium.launch({ headless: true });
  await check('poll-lock-clears-after-failure-and-later-state-refreshes', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
      await page.getByRole('heading', { name: '直播总览' }).waitFor();
      const state = await page.evaluate(async () => {
        const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('dashboard');
        store.stopPolling(); store.configLoaded = true;
        let calls = 0; const before = JSON.parse(JSON.stringify(store.dashboard));
        window.ballFight = { request: async request => {
          calls++;
          if (calls === 1) throw new Error('request timeout');
          if (request.path.startsWith('/api/queue')) return { page: 1, pageSize: 10, total: 0, rows: [] };
          return { ...before, status: 'recovered', revision: 42 };
        } };
        await store.refresh(); const first = { active: store.pollActive, error: store.error };
        await store.refresh(); return { first, active: store.pollActive, status: store.dashboard.status, error: store.error, calls };
      });
      assert.equal(state.first.active, false); assert.ok(state.first.error); assert.equal(state.active, false);
      assert.equal(state.status, 'recovered'); assert.equal(state.error, ''); assert.ok(state.calls >= 2);
    } finally { await page.close(); }
  });
} finally { await browser?.close(); await server?.close(); }
const result = { passed: results.every(r => r.passed), tests: results.length, results };
writeFileSync(join(output, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
process.exitCode = result.passed ? 0 : 1;
