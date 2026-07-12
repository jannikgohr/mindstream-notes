/**
 * WebdriverIO **multiremote** config for the T4 *three-client* tier: two devices
 * signed into the SAME account (A1 + A2) plus one other account (B). This is the
 * seam sharing-multi-device.e2e.ts needs to answer "when A shares a folder, does
 * A's *other* device also see the share badge and the shared notes?" — a
 * question the two-client wdio.multiremote.conf.ts can't reach.
 *
 * Kept as its own config (not merged into wdio.multiremote.conf.ts) so the
 * already-validated two-client suite keeps booting exactly two apps: a wdio
 * multiremote session waits for *every* declared capability to start, so adding
 * a third browser there would make the stable specs depend on a third app too.
 *
 * A single `tauri-driver` process hosts exactly one app, so three clients means
 * three tauri-driver processes on distinct ports, each launching the app against
 * its own MINDSTREAM_PROFILE_DIR + MINDSTREAM_PROFILE_ID (distinct on-disk data
 * *and* keyring namespace — A1 and A2 are the same user on two separate devices,
 * so they must not share a profile).
 *
 * Run with the backend stack up:
 *   pnpm backend:test:up
 *   MINDSTREAM_E2E_APP=1 MINDSTREAM_E2E_BACKEND=1 \
 *     MINDSTREAM_E2E_BACKEND_URL=http://localhost:18080 pnpm test:e2e:app:multi:a2
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

const binaryName =
  process.platform === 'win32' ? 'mindstream-notes.exe' : 'mindstream-notes';
const application = join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  binaryName
);

const tauriDriverPath = join(
  homedir(),
  '.cargo',
  'bin',
  process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver'
);

const buildEnv = {
  ...process.env,
  NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096'
};

/**
 * One tauri-driver process per client. `port` is what wdio connects to;
 * `nativePort` is the underlying WebKitWebDriver — every value must be unique
 * across the three so the processes don't fight over a socket. `profileDir` is a
 * fresh, throwaway data dir (the `dir_override` seam, e2e-data-dir feature); the
 * `profileId` namespaces the OS keyring entry so A1 and A2 (same account, two
 * devices) each hold their own session instead of clobbering one keyring slot.
 */
interface ClientProc {
  port: number;
  nativePort: number;
  profileId: string;
  profileDir: string;
  driver?: ChildProcess;
}

const clients: Record<'browserA1' | 'browserA2' | 'browserB', ClientProc> = {
  browserA1: {
    port: 4444,
    nativePort: 4445,
    profileId: 'e2e-a1',
    profileDir: mkdtempSync(join(tmpdir(), 'mindstream-e2e-a1-'))
  },
  browserA2: {
    port: 4448,
    nativePort: 4449,
    profileId: 'e2e-a2',
    profileDir: mkdtempSync(join(tmpdir(), 'mindstream-e2e-a2-'))
  },
  browserB: {
    port: 4446,
    nativePort: 4447,
    profileId: 'e2e-b',
    profileDir: mkdtempSync(join(tmpdir(), 'mindstream-e2e-b-'))
  }
};

function spawnDriver(client: ClientProc): ChildProcess {
  return spawn(
    tauriDriverPath,
    ['--port', String(client.port), '--native-port', String(client.nativePort)],
    {
      stdio: [null, process.stdout, process.stderr],
      env: {
        ...process.env,
        MINDSTREAM_PROFILE_DIR: client.profileDir,
        MINDSTREAM_PROFILE_ID: client.profileId
      }
    }
  );
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [join(here, 'specs', 'sharing-multi-device.e2e.ts')],
  maxInstances: 1,
  // Multiremote: an OBJECT keyed by instance name, each with its own connection
  // (port → its tauri-driver) plus capabilities. Cast as the two-client config
  // does — the multiremote object shape isn't the standalone array type.
  capabilities: {
    browserA1: {
      hostname: '127.0.0.1',
      port: clients.browserA1.port,
      capabilities: {
        'tauri:options': { application }
      } as WebdriverIO.Capabilities
    },
    browserA2: {
      hostname: '127.0.0.1',
      port: clients.browserA2.port,
      capabilities: {
        'tauri:options': { application }
      } as WebdriverIO.Capabilities
    },
    browserB: {
      hostname: '127.0.0.1',
      port: clients.browserB.port,
      capabilities: {
        'tauri:options': { application }
      } as WebdriverIO.Capabilities
    }
  } as unknown as WebdriverIO.Config['capabilities'],
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },

  onPrepare: () => {
    if (process.env.MINDSTREAM_E2E_SKIP_BUILD === '1') return;
    const res = spawnSync(
      'pnpm',
      ['tauri', 'build', '--no-bundle', '--features', 'e2e-data-dir'],
      { cwd: repoRoot, stdio: 'inherit', env: buildEnv }
    );
    if (res.status !== 0) {
      throw new Error('tauri build (--features e2e-data-dir) failed');
    }
  },

  beforeSession: () => {
    for (const client of Object.values(clients)) {
      if (!client.driver) client.driver = spawnDriver(client);
    }
  },

  afterSession: () => {
    for (const client of Object.values(clients)) {
      client.driver?.kill();
      client.driver = undefined;
    }
  }
};
