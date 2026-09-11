/**
 * WebDriverIO config for the real-app (T3/T4) tier — drives the packaged Tauri
 * binary through `tauri-driver`. This is the documented harness from
 * docs/e2e/harness.md; it is intentionally separate from the Playwright
 * browser-fallback suite and never runs in the default `pnpm test:e2e`.
 *
 * Requires the opt-in toolchain (see e2e-tests/app/README.md):
 *   - cargo: `tauri-driver` (and a platform webdriver: msedgedriver on Windows,
 *     WebKitWebDriver on Linux)
 *   - npm:   @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter
 *
 * Run with: `pnpm test:e2e:app`
 */

import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureFailureArtifacts,
  installPageDiagnostics
} from './helpers/failure-capture.js';
import {
  appBinary as application,
  preflight,
  repoRoot,
  spawnTauriDriver,
  stopTauriDriverTree
} from './helpers/preflight.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(repoRoot, '.output', 'wdio', 'single');

let tauriDriver: ChildProcess | undefined;

/**
 * The first of the two ports one worker needs: wdio talks to `port`,
 * tauri-driver drives the platform webdriver on `port + 1`.
 *
 * Running more than one spec file at a time means more than one tauri-driver,
 * so the fixed 4444/4445 pair has to become a pair per worker. wdio hands
 * `beforeSession` the runner id — `"0-6"`, whose last field counts spec files
 * and is unique for the run — and a config it will then connect with, so the
 * driver and the client can be pointed at the same fresh pair.
 */
const BASE_PORT = 4444;

function portsForRunner(cid: string): { port: number; nativePort: number } {
  const worker = Number(cid.split('-').pop() ?? 0);
  const port = BASE_PORT + worker * 2;
  return { port, nativePort: port + 1 };
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  hostname: '127.0.0.1',
  // Replaced per worker in beforeSession; this is only the fallback.
  port: BASE_PORT,
  specs: [
    // Windows-only, self-skipping elsewhere: guards the webview being left
    // marked invisible under a shown window, which paints nothing.
    join(here, '..', 'perf', 'hidden-visibility.e2e.ts'),
    join(here, 'specs', 'single', '**', '*.e2e.ts')
  ],
  // Two spec files at a time. The suite is one app per worker, so this is
  // two app processes on the runner rather than the T4 tiers' two or three,
  // and the wall clock floors out at the longest single spec file.
  maxInstances: 2,
  outputDir,
  capabilities: [
    {
      maxInstances: 2,
      // tauri-driver reads this to launch the app under WebDriver.
      'tauri:options': { application }
    } as WebdriverIO.Capabilities
  ],
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },
  // Two apps cold-starting at once take longer to answer than one did, and a
  // session that gives up here fails the whole spec file before it runs.
  connectionRetryTimeout: 180_000,

  // Requirement checks + the Tauri CLI build (helpers/preflight.ts). T3 needs
  // no backend.
  onPrepare: () => preflight({ backend: false }),

  // Start buffering page-side errors. WebKitWebDriver serves no log endpoint,
  // so what the app logged is only recoverable if the page kept it.
  beforeTest: () => installPageDiagnostics(browser),

  // A failed app-tier test leaves nothing behind to look at — the app is
  // headless in CI and gone by the time the log is read. Drop a screenshot,
  // the DOM and a diagnostics report next to the wdio logs, which the workflow
  // already uploads.
  afterTest: async (test, _context, { passed, error }) => {
    if (passed) return;
    await captureFailureArtifacts({
      client: browser,
      outputDir,
      title: `${test.parent} ${test.title}`,
      error
    });
  },

  // Spawn tauri-driver on this worker's own ports, with a fresh profile dir
  // for this spec file. In-spec reloadSession() calls keep the same driver
  // env, so restart-persistence assertions still relaunch against the same
  // data directory without leaking state across unrelated specs.
  beforeSession: (sessionConfig, _capabilities, _specs, cid) => {
    const { port, nativePort } = portsForRunner(cid);
    // wdio reads this back when it opens the session, so the client lands on
    // the driver this hook is about to start rather than the config default.
    sessionConfig.port = port;
    const runProfileDir = mkdtempSync(join(tmpdir(), 'mindstream-e2e-run-'));
    // Dictionaries sit outside the profile dir, so they need a disposable dir
    // of their own — without one a run would read and write the developer's
    // real dictionaries, and could only get one installed by downloading it.
    // Exported to this process as well, so a spec can seed a fixture pair.
    const runDictionaryDir = mkdtempSync(
      join(tmpdir(), 'mindstream-e2e-dict-')
    );
    process.env.MINDSTREAM_DICTIONARY_DIR = runDictionaryDir;
    tauriDriver = spawnTauriDriver(
      ['--port', String(port), '--native-port', String(nativePort)],
      {
        ...process.env,
        MINDSTREAM_PROFILE_DIR: runProfileDir,
        // Namespaces the OS keyring entry. Without it every worker writes to
        // the one `e2e` slot, which concurrent specs would race over.
        MINDSTREAM_PROFILE_ID: `e2e-${cid}`,
        MINDSTREAM_DICTIONARY_DIR: runDictionaryDir
      },
      join(outputDir, `tauri-driver-${cid}.log`)
    );
  },

  afterSession: async () => {
    await stopTauriDriverTree(tauriDriver);
    tauriDriver = undefined;
  }
};
