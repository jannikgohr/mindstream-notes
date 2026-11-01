import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: '../../.output/test-results/sqlite',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:1450', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: {
    command: 'pnpm build && pnpm preview --port 1450 --strictPort',
    url: 'http://localhost:1450/sqlite-proof/',
    reuseExistingServer: false,
    timeout: 240_000,
    env: { VITE_BROWSER_MOCKS: '0', VITE_BROWSER_TEST_VAULT: '' }
  }
});
