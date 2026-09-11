import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'file:///E:/code/jobflow-agent/frontend/node_modules/playwright/index.mjs';

const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 412, height: 915 }]) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(10000);
    const users = [{ id: 'admin', display_name: 'Admin', email: 'admin@example.com', system_role: 'admin' }];
    const departments = [];
    const calls = [];
    const members = [];
    const projectMembers = [];
    try {
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
        if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const body = request.postDataJSON();
        calls.push({ path, method, body, authorization: request.headers().authorization });
        let json = {};
        if (path === '/v1/auth/login') json = { access_token: 'offline-fixture', user: users[0] };
        else if (path === '/v1/auth/me') json = users[0];
        else if (path === '/v1/organization/users') {
          if (method === 'POST') { users.push({ id: 'employee', ...body, system_role: 'member' }); json = users.at(-1); }
          else json = { users };
        } else if (path === '/v1/departments') {
          if (method === 'POST') { departments.push({ id: 'engineering', ...body }); json = departments.at(-1); }
          else json = { departments };
        } else if (path === '/v1/departments/engineering/members') {
          if (method === 'PUT') members.push({ ...users.find(user => user.id === body.user_id), role: body.role });
          json = { members };
        } else if (path === '/v1/projects') json = { projects: [{ id: 'project', name: 'Project One', visibility: 'project' }] };
        else if (path === '/v1/projects/project/members') {
          if (method === 'PUT') projectMembers.push({ ...users.find(user => user.id === body.user_id), role: body.role });
          json = { members: projectMembers };
        } else if (path.endsWith('/sessions')) json = { sessions: [] };
        await route.fulfill({ headers, json });
      });
      await page.goto('http://localhost:3011/login');
      await page.getByPlaceholder('企业邮箱', { exact: true }).fill('admin@example.com');
      await page.getByPlaceholder('密码（至少8位）', { exact: true }).fill('offline-pass-123');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL('**/chat');
      await page.goto('http://localhost:3011/organization');
      await page.getByRole('heading', { name: '组织与权限' }).waitFor();
      await page.getByPlaceholder('员工姓名').fill('Offline Member');
      await page.getByPlaceholder('企业邮箱', { exact: true }).fill('employee@example.com');
      await page.getByPlaceholder('初始密码（至少8位）').fill('offline-pass-123');
      await page.getByRole('button', { name: '创建账号', exact: true }).click();
      await page.getByPlaceholder('部门名称').fill('Engineering');
      await page.getByRole('button', { name: '建立部门', exact: true }).click();
      await page.getByRole('button', { name: /Engineering/ }).waitFor();
      const departmentForm = page.locator('form').filter({ has: page.getByRole('button', { name: '加入', exact: true }) });
      await departmentForm.getByRole('combobox').nth(0).selectOption('employee');
      await departmentForm.getByRole('combobox').nth(1).selectOption('admin');
      await departmentForm.getByRole('button', { name: '加入', exact: true }).click();
      await page.getByText('employee@example.com', { exact: true }).waitFor();
      const projectForm = page.locator('form').filter({ has: page.getByRole('button', { name: '授权', exact: true }) });
      await projectForm.getByRole('combobox').nth(0).selectOption('employee');
      await projectForm.getByRole('combobox').nth(1).selectOption('member');
      await projectForm.getByRole('button', { name: '授权', exact: true }).click();
      await page.waitForFunction(() => document.body.innerText.includes('Offline Member · 成员'));
      assert.ok(calls.some(call => call.path.endsWith('/engineering/members') && call.method === 'PUT' && call.body.role === 'admin'));
      assert.ok(calls.some(call => call.path.endsWith('/project/members') && call.method === 'PUT' && call.body.role === 'member'));
      assert.ok(calls.filter(call => call.path === '/v1/organization/users').every(call => call.authorization === 'Bearer offline-fixture'));
      results.push({ viewport, passed: true });
    } catch (error) {
      await page.screenshot({ path: join(output, `failure-${viewport.width}.png`) });
      results.push({ viewport, passed: false, error: error.message });
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
writeFileSync(join(output, 'results.json'), JSON.stringify({ passed: results.every(result => result.passed), results }, null, 2));
console.log(JSON.stringify(results));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
