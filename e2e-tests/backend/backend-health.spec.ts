import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Local-only health gating for the mindstream-server stack (docs/e2e/backend-stack.md
 * §2.2). These are the probes that must pass before the (not-yet-built) T4
 * collaboration specs can run against a real backend, so they double as a quick
 * "is my stack actually up and routed correctly?" smoke test.
 *
 * Everything goes through the single nginx edge — the same one URL the client
 * connects to — exercising the path routing in backend/nginx/nginx.conf:
 *   /healthz     → nginx itself
 *   /socket.io/  → excalidraw-room   (freeform live sync)
 *   /yjs         → yjs-relay         (markdown + PDF Yjs collab)
 *   /            → etebase           (encrypted storage + auth)
 *
 * Gated behind MINDSTREAM_E2E_BACKEND so `pnpm test:e2e:backend` skips cleanly
 * when the stack isn't running. See e2e-tests/backend/playwright.config.ts to run it.
 */

const ENABLED = !!process.env.MINDSTREAM_E2E_BACKEND;
const BASE = (
  process.env.MINDSTREAM_E2E_BACKEND_URL ?? 'http://localhost:8080'
).replace(/\/$/, '');

/**
 * Attempt a WebSocket upgrade and resolve with the HTTP status the server
 * answered the handshake with (101 on success). yjs-relay speaks WS, not plain
 * HTTP, so a 101 is the only way to prove the route reaches a live relay.
 */
function wsHandshakeStatus(url: string, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64')
      }
    });
    const done = (fn: () => void) => {
      req.destroy();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error('ws handshake timed out'))),
      timeoutMs
    );
    // 101 Switching Protocols arrives as an 'upgrade' event, not 'response'.
    req.on('upgrade', (res) => {
      clearTimeout(timer);
      done(() => resolve(res.statusCode ?? 0));
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      done(() => resolve(res.statusCode ?? 0));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
    req.end();
  });
}

test.describe('local backend health (mindstream-server)', () => {
  test.skip(
    !ENABLED,
    'Set MINDSTREAM_E2E_BACKEND=1 and bring up backend/ (docker compose up -d) to run backend health checks.'
  );

  test('nginx edge is live (/healthz)', async ({ request }) => {
    const res = await request.get(`${BASE}/healthz`);
    expect(res.status()).toBe(200);
    expect((await res.text()).trim()).toBe('ok');
  });

  test('excalidraw-room answers the socket.io handshake', async ({
    request
  }) => {
    const res = await request.get(`${BASE}/socket.io/?EIO=4&transport=polling`);
    expect(res.status()).toBe(200);
    // Engine.IO opens every session with a packet whose type prefix is "0".
    expect((await res.text()).startsWith('0')).toBe(true);
  });

  test('yjs-relay accepts a WebSocket upgrade on /yjs', async () => {
    const status = await wsHandshakeStatus(`${BASE}/yjs?room=health-probe`);
    expect(status).toBe(101);
  });

  test('etebase is reachable behind the edge', async ({ request }) => {
    // The canonical "is this an Etebase server?" endpoint. We assert it
    // *responded* (any non-gateway status) rather than a specific body, so the
    // probe survives Etebase version bumps — a 502/504 is the real failure,
    // meaning nginx could not reach the upstream.
    const res = await request.get(`${BASE}/api/v1/authentication/is_etebase/`, {
      failOnStatusCode: false
    });
    expect([502, 503, 504]).not.toContain(res.status());
  });
});
