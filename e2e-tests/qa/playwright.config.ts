import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  outputDir: '../../.output/test-results/qa',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:1452', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command:
      'node scripts/browser/run.mjs qa build --skip-wasm && pnpm preview --port 1452 --strictPort',
    url: 'http://localhost:1452',
    reuseExistingServer: false,
    timeout: 240_000,
    env: { VITE_BROWSER_TEST_VAULT: 'qa' }
  }
});
