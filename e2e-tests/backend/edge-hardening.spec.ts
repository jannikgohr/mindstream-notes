import { expect, test } from '@playwright/test';

/**
 * nginx edge hardening, against the real stack.
 *
 * **Opt-in on purpose.** Tripping the auth limiter drains the bucket for the
 * whole source address, and every other T4 suite signs in through the same
 * edge — so running this alongside them would fail *them*, not this. Refill is
 * 10 r/m, so allow a couple of minutes before an app suite runs.
 *
 *   MINDSTREAM_E2E_BACKEND=1 MINDSTREAM_E2E_EDGE_LIMITS=1 \
 *     MINDSTREAM_E2E_BACKEND_URL=http://localhost:18080 pnpm test:e2e:backend
 *
 * Note the topology caveat: with the stack's port published directly, nginx
 * sees the Docker gateway as the client for every request, so all callers
 * share one bucket. That is enough to prove the limiter is wired up; proving
 * it partitions *per client* needs a real reverse proxy in front setting
 * X-Forwarded-For, which is what `real_ip` in nginx.conf exists to consume.
 */

const ENABLED =
  !!process.env.MINDSTREAM_E2E_BACKEND &&
  !!process.env.MINDSTREAM_E2E_EDGE_LIMITS;
const BASE = (
  process.env.MINDSTREAM_E2E_BACKEND_URL ?? 'http://localhost:8080'
).replace(/\/$/, '');

test.describe('nginx edge hardening', () => {
  test.skip(
    !ENABLED,
    'Set MINDSTREAM_E2E_BACKEND=1 and MINDSTREAM_E2E_EDGE_LIMITS=1 to run edge limit checks (drains the auth rate-limit bucket).'
  );

  test('throttles a burst against the etebase auth endpoint', async ({
    request
  }) => {
    // limit_req is 10 r/m with burst=20, so a burst well past that must start
    // shedding. Unthrottled, this endpoint is an offline password-guessing
    // oracle bounded only by bandwidth.
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await request.post(
        `${BASE}/api/v1/authentication/login_challenge/`,
        {
          data: { username: `nobody-${i}` },
          failOnStatusCode: false
        }
      );
      statuses.push(res.status());
    }

    expect(
      statuses.filter((s) => s === 429).length,
      `expected some 429s, got: ${JSON.stringify(statuses)}`
    ).toBeGreaterThan(0);
  });

  test('does not throttle ordinary sync traffic', async ({ request }) => {
    // The limiter is scoped to /api/v1/authentication/ precisely so a
    // request-heavy sync isn't collateral damage.
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await request.get(`${BASE}/api/v1/collection/`, {
        failOnStatusCode: false
      });
      statuses.push(res.status());
    }

    expect(statuses).not.toContain(429);
  });

  test('does not throttle the non-credential auth endpoints', async ({
    request
  }) => {
    // is_etebase/, logout/ and dashboard_url/ share the
    // /api/v1/authentication/ prefix but are not a guessing surface. An
    // earlier version of this config limited the whole prefix, which would
    // have throttled a capability probe alongside real login attempts.
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await request.get(
        `${BASE}/api/v1/authentication/is_etebase/`,
        { failOnStatusCode: false }
      );
      statuses.push(res.status());
    }

    expect(statuses).not.toContain(429);
  });

  test('ignores a client-supplied X-Forwarded-Proto from an untrusted peer', async ({
    request
  }) => {
    // Honouring this from anyone lets a direct client claim https and slip
    // past Django's CSRF origin check. Asserted indirectly: the request is
    // still served rather than redirected or 400'd on a scheme mismatch.
    const res = await request.get(`${BASE}/api/v1/authentication/is_etebase/`, {
      headers: { 'X-Forwarded-Proto': 'https' },
      failOnStatusCode: false
    });
    expect([502, 503, 504]).not.toContain(res.status());
  });
});
