/**
 * Cross-platform driver for the disposable T4 test stack
 * (backend/docker-compose.test.yml). Wraps `docker compose` so the same
 * `pnpm backend:test:*` scripts work on Linux, macOS and Windows.
 *
 * Commands:
 *   up      build + start the full stack detached, then print how to reach it
 *   up:min  start ONLY etebase + postgres (both pulled images) for the sharing
 *           suite — no image builds, so it works even when the Docker bridge
 *           has no outbound internet. Skips the nginx edge and the yjs/
 *           excalidraw build services (docker-compose.test-min.yml).
 *   down    stop + remove the containers (keeps volumes)
 *   reset   `down -v` (wipe volumes) then a fresh `up` — a clean slate
 *   logs    tail a service, e.g. `... logs etebase`
 *   status  `ps` for the test project
 *
 * Docker access differs by platform: Docker Desktop (macOS/Windows) and
 * rootless Docker need no sudo, but a rootful Linux daemon does. So on
 * Linux we prefix `sudo` unless we are already root or the caller opts out
 * with MINDSTREAM_DOCKER_NO_SUDO=1 (rootless / docker-group setups).
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, '..');

const PROJECT = 'mindstream-test';
const NGINX_PORT = process.env.NGINX_PORT ?? '18080';

function composeArgsFor(overlay) {
  return [
    'compose',
    '-f',
    join(backendDir, 'docker-compose.yml'),
    '-f',
    join(backendDir, overlay),
    '--env-file',
    join(backendDir, '.env.test'),
    '-p',
    PROJECT
  ];
}

const composeArgs = composeArgsFor('docker-compose.test.yml');
// Build-free sharing-only overlay: publishes etebase directly, no build
// services. `up -d etebase` starts only etebase + its postgres dependency.
const minComposeArgs = composeArgsFor('docker-compose.test-min.yml');

function needsSudo() {
  if (process.platform !== 'linux') return false;
  if (process.env.MINDSTREAM_DOCKER_NO_SUDO === '1') return false;
  // process.getuid is undefined on Windows; on Linux root === 0.
  return process.getuid?.() !== 0;
}

function docker(args, { check = true } = {}) {
  const sudo = needsSudo();
  const cmd = sudo ? 'sudo' : 'docker';
  const argv = sudo ? ['docker', ...args] : args;
  const res = spawnSync(cmd, argv, { cwd: backendDir, stdio: 'inherit' });
  if (res.error) {
    console.error(`[test-stack] failed to run docker: ${res.error.message}`);
    process.exit(1);
  }
  if (check && res.status !== 0) process.exit(res.status ?? 1);
  return res.status ?? 0;
}

function printReachInfo() {
  const url = `http://localhost:${NGINX_PORT}`;
  console.log('\n[test-stack] T4 backend is starting.');
  console.log(`[test-stack]   URL:        ${url}`);
  console.log('[test-stack]   Signup:     AUTO_SIGNUP=true (test stack only)');
  console.log('[test-stack]   Admin user: admin / mindstream-test-admin');
  console.log(
    `[test-stack] Health-gate it with: pnpm test:e2e:backend` +
      (url === 'http://localhost:18080'
        ? ''
        : ` (MINDSTREAM_E2E_BACKEND_URL=${url})`)
  );
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'up':
    docker([...composeArgs, 'up', '-d', '--build', ...rest]);
    printReachInfo();
    break;
  case 'up:min':
    // Only etebase (+ its postgres dependency). Both are pulled images, so no
    // `--build` — this is the whole point: it comes up without container
    // internet. Any extra args (e.g. a service name) still pass through.
    docker([...minComposeArgs, 'up', '-d', 'etebase', ...rest]);
    printReachInfo();
    break;
  case 'down':
    docker([...composeArgs, 'down', ...rest]);
    break;
  case 'reset':
    docker([...composeArgs, 'down', '-v']);
    docker([...composeArgs, 'up', '-d', '--build', ...rest]);
    printReachInfo();
    break;
  case 'logs':
    docker([...composeArgs, 'logs', ...rest]);
    break;
  case 'status':
    docker([...composeArgs, 'ps', ...rest]);
    break;
  default:
    console.error(
      `[test-stack] unknown command: ${command ?? '(none)'}\n` +
        'Usage: node backend/scripts/test-stack.mjs <up|up:min|down|reset|logs|status>'
    );
    process.exit(1);
}
