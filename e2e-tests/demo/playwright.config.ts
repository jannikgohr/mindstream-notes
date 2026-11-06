import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  outputDir: '../../.output/test-results/demo',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:1453/mindstream-notes/',
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
    url: 'http://localhost:1453/mindstream-notes/',
    reuseExistingServer: false,
    timeout: 30_000,
    env: { BROWSER_BASE_PATH: '/mindstream-notes' }
  }
});
