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

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appBinary as application,
  preflight,
  repoRoot,
  tauriDriverPath
} from './helpers/preflight.js';

const here = dirname(fileURLToPath(import.meta.url));

// A single profile dir for the whole run; specs that assert restart-persistence
// relaunch against this same dir. Set fresh per run so state never leaks.
const runProfileDir = join(
  process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
  `mindstream-e2e-run-${Date.now()}`
);

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: 4444,
  specs: [
    join(here, 'specs', 'backup.e2e.ts'),
    join(here, 'specs', 'editor-roundtrip.e2e.ts'),
    join(here, 'specs', 'history.e2e.ts'),
    join(here, 'specs', 'settings-persist.e2e.ts'),
    join(here, 'specs', 'trash-retention.e2e.ts')
  ],
  maxInstances: 1,
  outputDir: join(repoRoot, '.output', 'wdio', 'single'),
  capabilities: [
    {
      maxInstances: 1,
      // tauri-driver reads this to launch the app under WebDriver.
      'tauri:options': { application }
    } as WebdriverIO.Capabilities
  ],
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },

  // Requirement checks + the Tauri CLI build (helpers/preflight.ts). T3 needs
  // no backend.
  onPrepare: () => preflight({ backend: false }),

  // Spawn tauri-driver with the run's profile dir on its env so the launched
  // app is redirected to an isolated, throwaway data directory.
  beforeSession: () => {
    tauriDriver = spawn(tauriDriverPath, [], {
      stdio: [null, process.stdout, process.stderr],
      env: { ...process.env, MINDSTREAM_PROFILE_DIR: runProfileDir }
    });
  },

  afterSession: () => {
    tauriDriver?.kill();
  }
};
