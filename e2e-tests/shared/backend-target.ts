/**
 * The one place that decides which backend the e2e suites talk to, shared by
 * the app tier (T3/T4, wdio) and the backend probe tier (Playwright).
 *
 * Defaults to the **test** stack (`backend/docker-compose.test.yml`, brought up
 * with `pnpm backend:test:up`), NOT the dev stack on 8080. The two run on
 * separate ports on purpose so both can be up at once, and these suites create,
 * trash and share data — pointing them at a dev stack would write that into a
 * real vault. Override with `MINDSTREAM_E2E_BACKEND_URL` to target another
 * stack deliberately.
 */

export const DEFAULT_BACKEND_URL = 'http://localhost:18080';

const BASE = (
  process.env.MINDSTREAM_E2E_BACKEND_URL ?? DEFAULT_BACKEND_URL
).replace(/\/$/, '');

/** The server URL the suites should point the app / probes at. */
export function backendUrl(): string {
  return BASE;
}

/**
 * Resolve once the nginx edge answers /healthz, else throw with the fix.
 *
 * Called from a pre-flight hook (wdio `onPrepare` / Playwright `globalSetup`)
 * so a stack that isn't up is one loud failure before any test starts, rather
 * than a silent skip or a pile of mid-test timeouts.
 */
export async function assertBackendReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
      lastErr = new Error(`/healthz -> ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `backend at ${BASE} not ready: ${String(lastErr)}. ` +
      `Bring the test stack up with \`pnpm backend:test:up\` before running ` +
      `these specs (or \`pnpm backend:test:reset\` for a clean slate). ` +
      `Point at a different stack with MINDSTREAM_E2E_BACKEND_URL.`
  );
}
