/**
 * T4 backend readiness — a lightweight gate the collaboration specs call in
 * their `before` hook so they fail fast (with a clear message) if the stack
 * isn't actually up, rather than timing out mid-test.
 *
 * This is the runtime cousin of e2e/backend/backend-health.spec.ts (which is
 * the standalone, Playwright-driven health probe). Here we only need a quick
 * "is the edge answering?" check before driving two app clients against it.
 */

const BASE = (
  process.env.MINDSTREAM_E2E_BACKEND_URL ?? 'http://localhost:8080'
).replace(/\/$/, '');

/** The server URL the app should be pointed at for T4. */
export function backendUrl(): string {
  return BASE;
}

/** Resolve once the nginx edge answers /healthz, else throw. */
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
      `Bring up backend/ (docker compose up -d) before running T4 specs.`
  );
}
