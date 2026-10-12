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
 * The client is checked out at the revision the app pins in
 * src-tauri/Cargo.lock, so the server is held to what the app actually ships.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/** The git source cargo recorded for the app's `etebase` dependency. */
function pinnedClient() {
  const lock = readFileSync(resolve(repoRoot, 'src-tauri/Cargo.lock'), 'utf8');
  const match =
    /name = "etebase"\r?\nversion = "[^"]+"\r?\nsource = "git\+([^#"]+)#([0-9a-f]+)"/.exec(
      lock
    );
  if (!match) {
    throw new Error(
      'src-tauri/Cargo.lock does not pin etebase to a git revision'
    );
  }
  return { url: match[1].replace(/\?.*$/, ''), revision: match[2] };
}

const { url, revision } = pinnedClient();
// Under target/ so it is ignored, and short enough for the Windows linker,
// which gives up on paths much longer than this one.
const checkout = resolve(serverDir, 'target/conformance-src');
if (!existsSync(resolve(checkout, '.git'))) {
  run('git', ['clone', '--quiet', url, checkout]);
}
run('git', ['-C', checkout, 'fetch', '--quiet', 'origin', revision]);
run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', revision]);

console.log(`etebase-rs ${revision.slice(0, 10)} against ${host}`);
run('cargo', ['test', '--test', 'service', '--', '--test-threads=1'], {
  cwd: checkout,
  env: {
    ...process.env,
    ETEBASE_TEST_HOST: host,
    CARGO_TARGET_DIR: resolve(serverDir, 'target/conformance')
  }
});
