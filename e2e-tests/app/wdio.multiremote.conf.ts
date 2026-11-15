/**
 * WebdriverIO **multiremote** config for the T4 two-client tier — the seam the
 * collaboration + sharing specs (docs/internal/e2e/status.md) need but the
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

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureWorker, multiWorkers } from './helpers/worker-isolation.js';
import {
  startClientDrivers,
  stopClientDrivers,
  type ClientProc
} from './helpers/client-drivers.js';
import {
  captureFailureArtifacts,
  installPageDiagnostics
} from './helpers/failure-capture.js';
import {
  appBinary as application,
  preflight,
  repoRoot
} from './helpers/preflight.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(repoRoot, '.output', 'wdio', 'multi');

const clients: Record<'browserA' | 'browserB', ClientProc> = {
  browserA: { port: 4444, nativePort: 4445, profileId: 'e2e-a' },
  browserB: { port: 4446, nativePort: 4447, profileId: 'e2e-b' }
};

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [join(here, 'specs', 'multi', '**', '*.e2e.ts')],
  // CI opts into two workers, each driving two apps. Local runs stay serial
  // unless explicitly enabled, since native startup is sensitive to host load.
  maxInstances: multiWorkers(),
  outputDir,
  // Multiremote: an OBJECT (not an array) keyed by instance name. Each entry
  // carries its own connection (port → its tauri-driver) plus capabilities.
  // `WebdriverIO.Config['capabilities']` is typed as the standalone array, so
  // the multiremote object shape needs a cast here.
  capabilities: {
    browserA: {
      hostname: '127.0.0.1',
      port: clients.browserA.port,
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
  onPrepare: () => preflight({ backend: true }),

  // Buffer page-side errors on both clients — WebKitWebDriver has no log
  // endpoint, so what the app logged is only recoverable from the page.
  beforeTest: () => installPageDiagnostics(browser),

  // Screenshot + DOM per client on failure — a two-client failure is usually
  // about what one client sees and the other doesn't (see helpers/failure-capture.ts).
  afterTest: async (test, _context, { passed, error }) => {
    if (passed) return;
    await captureFailureArtifacts({
      client: browser,
      outputDir,
      title: `${test.parent} ${test.title}`,
      error
    });
  },

  // Configure worker ports before starting their drivers.
  beforeSession: (_config, capabilities, _specs, cid) => {
    configureWorker(
      clients,
      capabilities as unknown as Record<string, { port?: number }>,
      cid
    );
    startClientDrivers(clients, outputDir);
  },

  afterSession: () => stopClientDrivers(clients)
};
