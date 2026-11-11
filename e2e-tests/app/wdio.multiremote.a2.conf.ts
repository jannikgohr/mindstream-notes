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

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureFailureArtifacts,
  installPageDiagnostics
} from './helpers/failure-capture.js';
import {
  startClientDrivers,
  stopClientDrivers,
  type ClientProc
} from './helpers/client-drivers.js';
import {
  appBinary as application,
  preflight,
  repoRoot
} from './helpers/preflight.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(repoRoot, '.output', 'wdio', 'multi-a2');

const clients: Record<'browserA1' | 'browserA2' | 'browserB', ClientProc> = {
  browserA1: { port: 4444, nativePort: 4445, profileId: 'e2e-a1' },
  browserA2: { port: 4448, nativePort: 4449, profileId: 'e2e-a2' },
  browserB: { port: 4446, nativePort: 4447, profileId: 'e2e-b' }
};

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [join(here, 'specs', 'multi-a2', '**', '*.e2e.ts')],
  maxInstances: 1,
  outputDir,
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
  onPrepare: () => preflight({ backend: true }),

  // Buffer page-side errors on every client — WebKitWebDriver has no log
  // endpoint, so what the app logged is only recoverable from the page.
  beforeTest: () => installPageDiagnostics(browser),

  // Screenshot + DOM per client on failure, same as the two-client config.
  afterTest: async (test, _context, { passed, error }) => {
    if (passed) return;
    await captureFailureArtifacts({
      client: browser,
      outputDir,
      title: `${test.parent} ${test.title}`,
      error
    });
  },

  beforeSession: () => startClientDrivers(clients, outputDir),

  afterSession: () => stopClientDrivers(clients)
};
