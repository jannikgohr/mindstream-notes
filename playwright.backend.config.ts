import { defineConfig } from '@playwright/test';

/**
 * Local-only Playwright config for tests that probe a **real** mindstream-server
 * backend (the `backend/` Docker Compose stack), not the browser-fallback SPA.
 *
 * It is deliberately separate from playwright.config.ts:
 *   - it has **no** `webServer` — these tests never build or serve the SPA,
 *     they talk to the running stack over HTTP/WebSocket;
 *   - its `testDir` is `e2e-backend/`, so the default `pnpm test:e2e` run and
 *     CI never pick these specs up.
 *
 * The suite is gated behind `MINDSTREAM_E2E_BACKEND` (set inside the specs), so
 * `pnpm test:e2e:backend` skips cleanly when the stack isn't up. To run it:
 *
 *   cd backend && cp .env.example .env   # set POSTGRES_PASSWORD
 *   docker compose up -d --build         # stack at http://localhost:8080
 *   cd .. && MINDSTREAM_E2E_BACKEND=1 pnpm test:e2e:backend
 *
 * Point at a non-default edge with MINDSTREAM_E2E_BACKEND_URL.
 */

export default defineConfig({
  testDir: './e2e-backend',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  expect: { timeout: 10_000 },
  // No browser/`webServer`: every spec here uses the `request` fixture or
  // raw Node sockets against the live stack.
  projects: [{ name: 'backend' }]
});
