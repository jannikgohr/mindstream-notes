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
 *   pnpm test:e2e:app:multi:a2
 */

import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appBinaryForProfile,
  preflight,
  repoRoot,
  spawnTauriDriver,
  stopTauriDriverTree
} from './helpers/preflight.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * One tauri-driver process per client. `port` is what wdio connects to;
 * `nativePort` is the underlying WebKitWebDriver — every value must be unique
 * across the three so the processes don't fight over a socket. `profileDir` is a
 * fresh, throwaway data dir per spec file (the `dir_override` seam,
 * e2e-data-dir feature); the `profileId` namespaces the OS keyring entry so A1
 * and A2 (same account, two devices) each hold their own session instead of
 * clobbering one keyring slot.
 */
interface ClientProc {
  port: number;
  nativePort: number;
  profileId: string;
  application: string;
  profileDir?: string;
  driver?: ChildProcess;
  startTimer?: ReturnType<typeof setTimeout>;
}

const clients: Record<'browserA1' | 'browserA2' | 'browserB', ClientProc> = {
  browserA1: {
    port: 4444,
    nativePort: 4445,
    profileId: 'e2e-a1',
    application: appBinaryForProfile('e2e-a1')
  },
  browserA2: {
    port: 4448,
    nativePort: 4449,
    profileId: 'e2e-a2',
    application: appBinaryForProfile('e2e-a2')
  },
  browserB: {
    port: 4446,
    nativePort: 4447,
    profileId: 'e2e-b',
    application: appBinaryForProfile('e2e-b')
  }
};

const DRIVER_START_STAGGER_MS = 20_000;

function spawnDriver(client: ClientProc): ChildProcess {
  client.profileDir = mkdtempSync(
    join(tmpdir(), `mindstream-${client.profileId}-`)
  );
  return spawnTauriDriver(
    ['--port', String(client.port), '--native-port', String(client.nativePort)],
    {
      ...process.env,
      MINDSTREAM_PROFILE_DIR: client.profileDir,
      MINDSTREAM_PROFILE_ID: client.profileId
    }
  );
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [join(here, 'specs', 'sharing-multi-device.e2e.ts')],
  maxInstances: 1,
  outputDir: join(repoRoot, '.output', 'wdio', 'multi-a2'),
  // Multiremote: an OBJECT keyed by instance name, each with its own connection
  // (port → its tauri-driver) plus capabilities. Cast as the two-client config
  // does — the multiremote object shape isn't the standalone array type.
  capabilities: {
    browserA1: {
      hostname: '127.0.0.1',
      port: clients.browserA1.port,
      capabilities: {
        'tauri:options': { application: clients.browserA1.application }
      } as WebdriverIO.Capabilities
    },
    browserA2: {
      hostname: '127.0.0.1',
      port: clients.browserA2.port,
      capabilities: {
        'tauri:options': { application: clients.browserA2.application }
      } as WebdriverIO.Capabilities
    },
    browserB: {
      hostname: '127.0.0.1',
      port: clients.browserB.port,
      capabilities: {
        'tauri:options': { application: clients.browserB.application }
      } as WebdriverIO.Capabilities
    }
  } as unknown as WebdriverIO.Config['capabilities'],
  logLevel: 'warn',
  connectionRetryTimeout: 220_000,
  connectionRetryCount: 220,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },

  // Retry a failed spec file once on a fresh session — same transient-boot
  // rationale as the two-client config (see wdio.multiremote.conf.ts).
  specFileRetries: 1,
  specFileRetriesDeferred: true,

  // Requirement checks + the Tauri CLI build, same as the two-client config
  // (helpers/preflight.ts).
  onPrepare: () =>
    preflight({
      backend: true,
      buildProfiles: ['e2e-a1', 'e2e-a2', 'e2e-b']
    }),

  beforeSession: () => {
    for (const [index, client] of Object.values(clients).entries()) {
      if (client.driver || client.startTimer) continue;
      if (index === 0) {
        client.driver = spawnDriver(client);
      } else {
        client.startTimer = setTimeout(() => {
          client.driver = spawnDriver(client);
          client.startTimer = undefined;
        }, index * DRIVER_START_STAGGER_MS);
      }
    }
  },

  afterSession: async () => {
    for (const client of Object.values(clients)) {
      if (client.startTimer) {
        clearTimeout(client.startTimer);
        client.startTimer = undefined;
      }
      await stopTauriDriverTree(client.driver);
      client.driver = undefined;
      client.profileDir = undefined;
    }
  }
};
