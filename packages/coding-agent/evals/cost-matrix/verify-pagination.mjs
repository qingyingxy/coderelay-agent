import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'file:///E:/code/ballfightlive-version/Tools/LiveCommentBridge/desktop/node_modules/vite/dist/node/index.js';
import { chromium } from 'file:///E:/code/jobflow-agent/frontend/node_modules/playwright/index.mjs';

const workspace = resolve(process.argv[2]); const output = resolve(process.argv[3]); mkdirSync(output, { recursive: true });
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONPATH: ['LiveCommentBridge', 'LiveOcrBridge', 'KuaishouLiveBridge', 'XiaohongshuLiveBridge', 'DouyinLiveBridge'].map(d => join(workspace, 'Tools', d)).join(';') };
const python = 'E:/code/ballfightlive-version/Tools/LiveCommentBridge/.venv/Scripts/python.exe';
const backend = spawnSync(python, [resolve('packages/coding-agent/evals/cost-matrix/test_pagination.py')], { cwd: join(workspace, 'Tools/LiveCommentBridge'), env, encoding: 'utf8', timeout: 120000, windowsHide: true });
const log = `${backend.stdout ?? ''}${backend.stderr ?? ''}${backend.error ?? ''}`;
writeFileSync(join(output, 'backend.txt'), log);
const regression = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], { cwd: join(workspace, 'Tools/LiveCommentBridge'), env, encoding: 'utf8', timeout: 120000, windowsHide: true });
writeFileSync(join(output, 'regression.txt'), `${regression.stdout ?? ''}${regression.stderr ?? ''}${regression.error ?? ''}`);
const results = []; let server; let browser;
try {
  server = await createServer({ root: join(workspace, 'Tools/LiveCommentBridge/desktop'), configLoader: 'native', cacheDir: join(output, 'vite'), server: { host: '127.0.0.1', port: 0, fs: { allow: [workspace, 'E:/code/ballfightlive-version/Tools/LiveCommentBridge/desktop/node_modules'] } } });
  await server.listen(); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  try {
    const fixture = JSON.parse(readFileSync(new URL('./live-browser-fixture.json', import.meta.url), 'utf8'));
    await page.addInitScript(({ state, config }) => {
      window.matrixCalls = []; window.matrixPending = []; window.matrixDelay = false;
      window.matrixHeartbeat = 76;
      window.ballFight = { request: async request => {
        window.matrixCalls.push(request.path);
        const url = new URL(request.path, 'http://test');
        if (url.pathname === '/api/state') return url.searchParams.get('since') === String(state.revision)
          ? { revision: state.revision, unchanged: true, uptimeSeconds: window.matrixHeartbeat }
          : structuredClone(state);
        if (url.pathname === '/api/config') return structuredClone(config);
        if (url.pathname !== '/api/queue') throw new Error('Unexpected path');
        const kind = url.searchParams.get('kind'); const number = Number(url.searchParams.get('page')); const size = Number(url.searchParams.get('pageSize'));
        const value = { revision: 1, kind, page: number, pageSize: size, total: 35, rows: Array.from({ length: Math.min(size, 35 - (number - 1) * size) }, (_, i) => ({ rank: (number - 1) * size + i + 1, viewerName: `${kind}-viewer-${(number - 1) * size + i + 1}`, platform: 'kuaishou', score: 10, points: 1, threshold: 10, waitingRounds: 0, missedRegistrations: 0, status: 'ready', eligibleNextDraw: true, availableTickets: 1 })) };
        if (window.matrixDelay) return new Promise(resolve => window.matrixPending.push({ kind, number, resolve: () => resolve(value) }));
        return value;
      } };
    }, fixture);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.getByRole('heading', { name: '直播总览' }).waitFor();
    await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('dashboard')?.ready);
    await page.evaluate(() => {
      window.matrixStore = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('dashboard');
      window.matrixStore.stopPolling();
    });
    await page.waitForFunction(() => !window.matrixStore.pollActive);
    for (const [kind, label] of [['free', '免费'], ['ordinary', '普通'], ['paid', '付费']]) {
      try {
        await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
        await page.getByText(new RegExp(`^${kind}-viewer-1(?:\\D|$)`)).waitFor();
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        await page.getByText(new RegExp(`^${kind}-viewer-11(?:\\D|$)`)).waitFor();
        assert.ok((await page.evaluate(() => window.matrixCalls)).some(p => p.includes('/api/queue?') && p.includes(`kind=${kind}`) && p.includes('page=2')));
        results.push({ name: `${kind}-ui-requests-server-page`, passed: true });
      } catch(e) { results.push({ name: `${kind}-ui-requests-server-page`, passed: false, error: e.message, diagnostics: await page.evaluate(() => ({ calls: window.matrixCalls, text: document.body.innerText, paid: window.matrixStore.paidQueue })) }); }
    }
    try {
      const check = await page.evaluate(async () => {
        const s = window.matrixStore;
        const before = JSON.parse(JSON.stringify(s.dashboard));
        window.matrixHeartbeat = 77;
        await s.refresh();
        return { preview: s.preview, before, after: JSON.parse(JSON.stringify(s.dashboard)), error: s.error };
      });
      assert.equal(check.preview, false, 'Must initialize in bridge mode');
      assert.equal(check.before.revision, 42, 'Initial snapshot revision');
      assert.equal(check.before.uptimeSeconds, 76, 'Initial snapshot uptime');
      for (const field of ['unity', 'counts', 'platforms', 'logs']) assert.deepEqual(check.before[field], fixture.state[field], `Initial snapshot ${field}`);
      assert.equal(check.error, '', 'Refresh error');
      assert.equal(check.after.revision, 42, 'Unchanged revision must remain 42, not heartbeat 77');
      assert.equal(check.after.uptimeSeconds, 77, 'Heartbeat uptime must update to 77');
      assert.deepEqual(check.after, { ...check.before, uptimeSeconds: 77 }, 'Unchanged response must preserve every other dashboard field');
      results.push({ name: 'unchanged-poll-preserves-full-state', passed: true, evidence: { revisionBefore: 42, revisionAfter: 42, uptimeBefore: 76, uptimeAfter: 77, otherFieldsPreserved: true } });
    } catch(e) { results.push({ name: 'unchanged-poll-preserves-full-state', passed: false, error: e.message }); }
    try {
      await page.evaluate(() => { window.matrixDelay = true; window.matrixPending = []; });
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      await page.waitForFunction(() => window.matrixPending.some(p => p.number === 1));
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.waitForFunction(() => window.matrixPending.some(p => p.number === 2));
      await page.evaluate(() => window.matrixPending.filter(p => p.number === 2).forEach(p => p.resolve()));
      await page.getByText(/^paid-viewer-11(?:\D|$)/).waitFor();
      await page.evaluate(() => window.matrixPending.filter(p => p.number === 1).forEach(p => p.resolve()));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByText(/^paid-viewer-11(?:\D|$)/).count(), 1);
      assert.equal(await page.getByText(/^paid-viewer-1(?:\D|$)/).count(), 0);
      results.push({ name: 'late-old-page-does-not-overwrite-new-page', passed: true });
    } catch(e) { results.push({ name: 'late-old-page-does-not-overwrite-new-page', passed: false, error: e.message }); }
  } finally { await page.close(); }
} finally { await browser?.close(); await server?.close(); }
const result = { passed: backend.status === 0 && regression.status === 0 && results.every(r => r.passed), backend: { exitCode: backend.status, summary: log }, regression: { exitCode: regression.status }, browser: results };
writeFileSync(join(output, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1;
