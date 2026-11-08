import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// The same default as `pnpm build:demo` (scripts/browser/run.mjs), so the
// tests serve whatever base path the build used, including '' for a custom
// domain.
const base = (process.env.BROWSER_BASE_PATH ?? '/mindstream-notes').replace(
  /\/+$/,
  ''
);
const url = `http://localhost:1453${base}/`;

export default defineConfig({
  testDir: '.',
  outputDir: '../../.output/test-results/demo',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: url,
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'pnpm preview --port 1453 --strictPort',
    url,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { BROWSER_BASE_PATH: base }
  }
});
