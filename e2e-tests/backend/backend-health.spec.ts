import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import { expect, test } from '@playwright/test';
import WebSocket from 'ws';
import { backendUrl } from '../shared/backend-target.js';

/**
 * Health gating for the sync server (docs/e2e/backend-stack.md). These are
 * the probes that must pass before the collaboration specs can run against a
 * real backend, so they double as a quick "is my stack up and is it the
 * right server?" smoke test.
 *
 * One server answers everything, on the one URL the app is given:
 *   /healthz                    liveness
 *   /api/v1/...                 accounts, storage and sharing
 *   /api/v1/room/               live rooms, over WebSocket
 *   /api/v1/mindstream/feed/    "sync now" notices, over WebSocket
 *   /join/<id>                  the page an invite link shows in a browser
 *
 * The stack itself is a precondition, checked once in global-setup.ts — see
 * e2e-tests/backend/playwright.config.ts to run this suite.
 */

const BASE = backendUrl();
const SOCKET_BASE = BASE.replace(/^http/, 'ws');

/**
 * Attempt a WebSocket upgrade and resolve with the HTTP status the server
 * answered the handshake with (101 on success).
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

/** Open a room socket, send one frame, and resolve with the close code. */
function roomCloseCode(firstFrame: Uint8Array, timeoutMs = 8000) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${SOCKET_BASE}/api/v1/room/`);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('the room socket was not closed'));
    }, timeoutMs);
    socket.on('open', () => socket.send(firstFrame));
    socket.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test.describe('local backend health (mindstream-server)', () => {
  test('the server is live (/healthz)', async ({ request }) => {
    const res = await request.get(`${BASE}/healthz`);
    expect(res.status()).toBe(200);
    expect((await res.text()).trim()).toBe('ok');
  });

  test('it is a Mindstream server at a protocol level the app knows', async ({
    request
  }) => {
    const res = await request.get(`${BASE}/api/v1/mindstream/info/`);
    expect(res.status()).toBe(200);
    const info = await res.json();
    expect(info.server).toBe('mindstream-server');
    expect(info.protocol).toBe(1);
    // The suites sign up their own accounts, which a real server's default
    // would refuse.
    expect(info.signup).toBe('open');
  });

  test('it answers the client library as an Etebase server', async ({
    request
  }) => {
    const res = await request.get(`${BASE}/api/v1/authentication/is_etebase/`);
    expect(res.status()).toBe(200);
  });

  test('storage is closed to a request without a session', async ({
    request
  }) => {
    const res = await request.get(`${BASE}/api/v1/collection/`, {
      failOnStatusCode: false
    });
    expect(res.status()).toBe(401);
  });

  test('a room socket opens, and closes on anything but a valid ticket', async () => {
    // The ticket travels in the first frame, so the upgrade itself is open.
    expect(await wsHandshakeStatus(`${BASE}/api/v1/room/`)).toBe(101);
    const hello = (ticket: string) =>
      Buffer.concat([Buffer.from([0x01]), Buffer.from(ticket)]);
    // 4401: no valid ticket.
    expect(await roomCloseCode(hello('bm90IGEgdGlja2V0'))).toBe(4401);
    // A document frame before any ticket gets the same answer.
    expect(await roomCloseCode(Buffer.from([0x10, 1, 2, 3]))).toBe(4401);
  });

  test('the change feed refuses a socket without a session', async () => {
    expect(await wsHandshakeStatus(`${BASE}/api/v1/mindstream/feed/`)).toBe(
      401
    );
  });

  test('an invite link opened in a browser shows a page', async ({
    request
  }) => {
    const res = await request.get(`${BASE}/join/some-link-id`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(res.headers()['content-security-policy']).toContain(
      "default-src 'none'"
    );
    // The page is the same for every link and never echoes the one asked for.
    expect(await res.text()).not.toContain('some-link-id');
  });
});
