/**
 * The test server's admin command, for the flows that need an account with
 * limits.
 *
 * A limit is set by whoever runs the server, never by the app, so a test
 * that wants one has to step outside the app to get it. The disposable stack
 * of `pnpm backend:test:up` runs the server in a container with a fixed
 * name, and the server's own command line sets the limits there, see
 * docs/server-administration.md.
 *
 * A suite pointed at a server somewhere else cannot do this. Such a flow
 * asks `serverAdminAvailable()` first and skips itself.
 */

import { spawnSync } from 'node:child_process';

const CONTAINER =
  process.env.MINDSTREAM_E2E_SERVER_CONTAINER ?? 'mindstream-test-server';

function admin(...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(
    'docker',
    ['exec', CONTAINER, 'mindstream-server', ...args],
    { encoding: 'utf8', timeout: 30_000 }
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  };
}

function must(what: string, result: { ok: boolean; output: string }): void {
  if (!result.ok) {
    throw new Error(`${what} failed in ${CONTAINER}: ${result.output}`);
  }
}

/** Whether the server runs where its admin command can be reached. */
export function serverAdminAvailable(): boolean {
  return admin('--help').ok;
}

/** End the account's plan: the server stores nothing new for anything it
 *  owns. Reading and deleting keep working. */
export function lapsePlan(username: string): void {
  must(
    `lapsing the plan of ${username}`,
    admin('user', 'limit', username, '--read-only')
  );
}

/** Take every limit off the account again. */
export function liftLimits(username: string): void {
  must(`lifting the limits of ${username}`, admin('user', 'unlimit', username));
}
