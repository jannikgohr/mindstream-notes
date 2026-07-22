import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local-only Playwright config for tests that probe a **real** mindstream-server
 * backend (the `backend/` Docker Compose stack), not the browser-fallback SPA.
 *
 * It is deliberately separate from the browser-fallback Playwright config:
 *   - it has **no** `webServer` — these tests never build or serve the SPA,
 *     they talk to the running stack over HTTP/WebSocket;
 *   - it lives in `e2e-tests/backend/`, so the default `pnpm test:e2e` run and CI
 *     never pick these specs up.
 *
 * There is no enable-flag: `global-setup.ts` health-checks the stack and fails
 * the run if it isn't answering, so a missing stack can't masquerade as a pass.
 * To run it:
 *
 *   pnpm backend:test:up          # test stack at http://localhost:18080
 *   pnpm test:e2e:backend
 *
 * Point at a non-default edge with MINDSTREAM_E2E_BACKEND_URL.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export default defineConfig({
  testDir: './',
  outputDir: resolve(repoRoot, '.output/test-results/backend'),
  // Requirement check before any spec runs — see global-setup.ts.
  globalSetup: resolve(here, 'global-setup.ts'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ['list'],
    [
      'html',
      {
        open: 'never',
        outputFolder: resolve(repoRoot, '.output/playwright-report/backend')
      }
    ]
  ],
  expect: { timeout: 10_000 },
  // No browser/`webServer`: every spec here uses the `request` fixture or
  // raw Node sockets against the live stack.
  projects: [{ name: 'backend' }]
});
