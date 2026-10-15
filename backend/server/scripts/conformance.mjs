/**
 * Run the Etebase client library's integration suite against a running
 * server.
 *
 *   node backend/server/scripts/conformance.mjs [host:port]
 *
 * The server must have been started with the reset route on
 * (MINDSTREAM_TEST_RESET=true) and signup open, because every test begins by
 * wiping and recreating its two accounts. The suite therefore runs one test
 * at a time. It also signs in more often than the sign-in limit allows, so
 * start the server with MINDSTREAM_AUTH_RATE_PER_MINUTE=0.
 *
 * The client is the one in vendor/etebase-rs, the copy the app ships, so the
 * server is held to what the app actually sends.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serverDir, '../..');
const host = process.argv[2] ?? '127.0.0.1:13735';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const client = resolve(repoRoot, 'vendor/etebase-rs');
if (!existsSync(resolve(client, 'Cargo.toml'))) {
  throw new Error(`no client library at ${client}`);
}

console.log(`vendor/etebase-rs against ${host}`);
run('cargo', ['test', '--test', 'service', '--', '--test-threads=1'], {
  cwd: client,
  env: {
    ...process.env,
    ETEBASE_TEST_HOST: host,
    CARGO_TARGET_DIR: resolve(serverDir, 'target/conformance')
  }
});
