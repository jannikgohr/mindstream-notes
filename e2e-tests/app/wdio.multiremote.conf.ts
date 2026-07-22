/**
 * WebdriverIO **multiremote** config for the T4 two-client tier — the seam the
 * collaboration + sharing specs (docs/e2e/status.md) need but the
 * single-client wdio.conf.ts can't provide. A single `tauri-driver` process
 * hosts exactly one app, so two clients means **two** tauri-driver processes on
 * distinct ports, each launching the app against its own MINDSTREAM_PROFILE_DIR.
 * wdio multiremote then drives both as `browserA` (sender / device A) and
 * `browserB` (recipient / device B).
 *
 * Run with the backend stack up:
 *   pnpm backend:test:up
 *   pnpm test:e2e:app:multi
 *
 * Only specs that need two clients belong here (sharing.e2e.ts, collab.e2e.ts);
 * the single-client T3 specs stay on wdio.conf.ts.
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
 * across the two so the processes don't fight over a socket. `profileDir` is a
 * fresh, throwaway data dir per spec file (the `dir_override` seam,
 * e2e-data-dir feature) so the two clients are fully isolated on disk without
 * leaking app/WebView state into the next session.
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

const clients: Record<'browserA' | 'browserB', ClientProc> = {
  browserA: {
    port: 4444,
    nativePort: 4445,
    profileId: 'e2e-a',
    application: appBinaryForProfile('e2e-a')
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
      // The launched app reads its data dir from here — this is what makes
      // the two clients distinct users' devices. The profile id namespaces the
      // OS keyring entry; without it both clients default to `e2e`.
      MINDSTREAM_PROFILE_DIR: client.profileDir,
      MINDSTREAM_PROFILE_ID: client.profileId
    }
  );
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [
    // Only the two-client specs. The rest run on wdio.conf.ts.
    join(here, 'specs', 'collab-confirm.e2e.ts'),
    join(here, 'specs', 'sharing.e2e.ts'),
    join(here, 'specs', 'collab.e2e.ts'),
    join(here, 'specs', 'sync-history.e2e.ts'),
    join(here, 'specs', 'seed-merge.e2e.ts')
  ],
  maxInstances: 1,
  outputDir: join(repoRoot, '.output', 'wdio', 'multi'),
  // Multiremote: an OBJECT (not an array) keyed by instance name. Each entry
  // carries its own connection (port → its tauri-driver) plus capabilities.
  // `WebdriverIO.Config['capabilities']` is typed as the standalone array, so
  // the multiremote object shape needs a cast here.
  capabilities: {
    browserA: {
      hostname: '127.0.0.1',
      port: clients.browserA.port,
      capabilities: {
        'tauri:options': { application: clients.browserA.application }
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
  connectionRetryTimeout: 180_000,
  connectionRetryCount: 180,
  framework: 'mocha',
  reporters: ['spec'],
  // 4 minutes, not the single-client config's 2. Every spec here opens its
  // `before all` with two real Etebase signups and two full UI sign-ins (one
  // per client), and each spec file launches a fresh pair of app instances.
  // Alone that hook finishes well inside 2 minutes; across a five-spec run the
  // machine is loaded enough that it can cross it, and the whole file then
  // reports as failed without a single assertion having run. The assertions
  // themselves are unaffected — this only stops a slow setup being reported as
  // a broken spec.
  mochaOpts: { ui: 'bdd', timeout: 240_000 },

  // Re-run a failed spec file once with a fresh session (new drivers + a fresh
  // app boot). The remaining flake after the context-menu fix is a transient:
  // a fresh WebView2 host occasionally becomes CDP-responsive too slowly under
  // momentary machine load, so wdio's aria/ findElement (an injected page
  // script) hangs at the transport layer or misses its 30s wait. That is not a
  // logic failure — a clean reboot clears it — so one retry absorbs it without
  // masking a real regression (a genuinely broken spec fails both attempts).
  specFileRetries: 1,
  specFileRetriesDeferred: true,

  // Requirement checks + the Tauri CLI build (helpers/preflight.ts). T4 also
  // requires the backend stack, so a down stack fails here — once, before the
  // build — instead of five specs each timing out in their `before` hook.
  onPrepare: () =>
    preflight({ backend: true, buildProfiles: ['e2e-a', 'e2e-b'] }),

  // Bring up tauri-driver processes on a stagger. wdio opens multiremote
  // sessions concurrently; if both driver ports are already listening, that
  // means both native Tauri/WebView2 hosts cold-start together. On Windows that
  // occasionally leaves one app process not responding before Svelte mounts.
  // Leaving later ports closed briefly makes wdio's normal connection retry
  // machinery serialize the expensive native app boot without changing specs.
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
