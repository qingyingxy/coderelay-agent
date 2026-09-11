import { defineConfig, devices } from 'file:///E:/code/jobflow-agent/frontend/node_modules/@playwright/test/index.mjs';
import { resolve } from 'node:path';

const root = resolve(process.env.MATRIX_WORKSPACE, 'frontend');
export default defineConfig({
  testDir: resolve(root, 'e2e'),
  testMatch: /(?:ats-assistance|attempts|follow-ups|packets)\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20000,
  reporter: [['json', { outputFile: resolve(process.env.MATRIX_OUTPUT, 'results.json') }]],
  outputDir: resolve(process.env.MATRIX_OUTPUT, 'test-results'),
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.MATRIX_EXTERNAL_SERVER === '1' ? undefined : {
    command: 'node node_modules/next/dist/bin/next dev --webpack --hostname localhost --port 3000',
    cwd: root,
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 120000,
    env: { NEXT_PUBLIC_API_URL: 'http://127.0.0.1:18001', NEXT_TELEMETRY_DISABLED: '1' },
  },
});
