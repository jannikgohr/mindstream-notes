import { expect, test } from '@playwright/test';
import { backendUrl } from '../shared/backend-target.js';

/**
 * What the server does in the place a reverse proxy used to: slow down
 * password guessing, and send headers that keep its answers from being
 * framed or sniffed.
 *
 * The headers are checked on every run. The sign-in limit is opt-in, for two
 * reasons. The test stack runs with the limit off, because every suite
 * arrives from one address. And a run that trips the limit leaves that
 * address throttled for the next minute. To run it:
 *
 *   MINDSTREAM_AUTH_RATE_PER_MINUTE=10 pnpm backend:test:up
 *   MINDSTREAM_E2E_EDGE_LIMITS=1 pnpm test:e2e:backend
 */

const BASE = backendUrl();
const LIMITS_ENABLED = !!process.env.MINDSTREAM_E2E_EDGE_LIMITS;

test.describe('edge hardening', () => {
  test('sends security headers on every kind of answer', async ({
    request
  }) => {
    for (const path of [
      '/healthz',
      '/api/v1/mindstream/info/',
      '/api/v1/collection/',
      '/join/some-link-id'
    ]) {
      const res = await request.get(`${BASE}${path}`, {
        failOnStatusCode: false
      });
      const headers = res.headers();
      expect(headers['x-content-type-options'], path).toBe('nosniff');
      expect(headers['x-frame-options'], path).toBe('DENY');
      expect(headers['referrer-policy'], path).toBe('no-referrer');
    }
  });

  test.describe('sign-in limit', () => {
    test.skip(
      !LIMITS_ENABLED,
      'Set MINDSTREAM_E2E_EDGE_LIMITS=1, with the stack started under MINDSTREAM_AUTH_RATE_PER_MINUTE=10, to run the sign-in limit checks. They leave this address throttled for a minute.'
    );

    test('throttles a burst of sign-in attempts', async ({ request }) => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const res = await request.post(
          `${BASE}/api/v1/authentication/login_challenge/`,
          { data: Buffer.from([0x80]), failOnStatusCode: false }
        );
        statuses.push(res.status());
      }
      expect(
        statuses.filter((status) => status === 429).length,
        `statuses: ${statuses.join(',')}`
      ).toBeGreaterThan(0);
    });

    test('does not throttle ordinary sync traffic', async ({ request }) => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const res = await request.get(`${BASE}/api/v1/collection/`, {
          failOnStatusCode: false
        });
        statuses.push(res.status());
      }
      expect(statuses).not.toContain(429);
    });

    test('does not throttle the endpoints that take no credentials', async ({
      request
    }) => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const res = await request.get(
          `${BASE}/api/v1/authentication/is_etebase/`,
          { failOnStatusCode: false }
        );
        statuses.push(res.status());
      }
      expect(statuses).not.toContain(429);
    });
  });
});
