/**
 * WebDriverIO config for the real-app (T3/T4) tier — drives the packaged Tauri
 * binary through `tauri-driver`. This is the documented harness from
 * docs/e2e-strategy.md §3; it is intentionally separate from the Playwright
 * browser-fallback suite and never runs in the default `pnpm test:e2e`.
 *
 * Requires the opt-in toolchain (see e2e-app/README.md):
 *   - cargo: `tauri-driver` (and a platform webdriver: msedgedriver on Windows,
 *     WebKitWebDriver on Linux)
 *   - npm:   @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter
 *
 * Run with: `MINDSTREAM_E2E_APP=1 pnpm test:e2e:app`
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// The cargo-built (not bundled/installer) binary. Cargo names it after the
// package, `mindstream-notes`; on Windows it carries the .exe suffix.
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
  specs: [join(here, 'specs', '**', '*.e2e.ts')],
  maxInstances: 1,
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

  // Build through the Tauri CLI, not plain Cargo. The CLI runs the frontend
  // build and injects the production asset config; direct `cargo build` leaves
  // the binary pointing at the dev server, which renders as a blank webview
  // when Vite is not running. Skip with MINDSTREAM_E2E_SKIP_BUILD=1 only after
  // a successful Tauri CLI build.
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
