import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright drives the SvelteKit frontend in its **browser-fallback**
 * mode — when the app runs outside Tauri it serves a fully working SPA
 * backed by the in-memory mock store (src/lib/api/mock-store.ts), seeded
 * with the same Welcome / Personal / Work demo content the Rust side
 * inserts on first run. That makes the whole UI — tree, editor, search,
 * settings, trash — exercisable end to end without a Rust build.
 *
 * These tests cover the `.svelte` components that unit tests can't reach
 * (vitest coverage shows them at 0%), which is exactly where the unit
 * suite stops paying off.
 *
 * Port 1440 is deliberately neither Vite's dev port (1420) nor the
 * `.claude/launch.json` preview port (1430), so an e2e run never fights
 * a dev server the developer already has open.
 *
 * The web server builds the SPA and serves it with `vite preview` rather
 * than `vite dev`: prebuilt static assets load deterministically, so the
 * fully-parallel run doesn't stampede a cold dev server still compiling
 * modules on demand (which made the first wave of tests flake).
 */

const PORT = 1440;

export default defineConfig({
  testDir: './',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { NODE_OPTIONS: '--max-old-space-size=4096' }
  }
});
