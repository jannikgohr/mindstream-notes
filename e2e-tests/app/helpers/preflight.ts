/**
 * Pre-flight requirement checks for the real-app (T3/T4) suites.
 *
 * These run in the wdio `onPrepare` hook — *before* any driver is spawned or
 * any spec is loaded — so an unmet requirement is a single, explicit failure
 * with a fix in the message, rather than a cryptic mid-test timeout (or, worse,
 * a silently skipped run that still reports "passed").
 *
 * Checks are ordered cheapest-and-most-likely-wrong first, so you learn about a
 * missing driver or a down backend before sitting through a multi-minute build.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SevereServiceError } from 'webdriverio';
import { assertBackendReady } from './backend.js';

/**
 * Fail the whole run, not just this hook.
 *
 * `onPrepare` errors are swallowed by wdio: `runLauncherHook` catches, logs,
 * and lets the run continue — *unless* the error is a `SevereServiceError`,
 * which is the only type it rethrows (see @wdio/cli's runLauncherHook). A
 * plain `throw new Error` here would log a message nobody reads and then run
 * the suite anyway against the very environment we just rejected.
 */
function fail(message: string): never {
  throw new SevereServiceError(message);
}

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');
const exeSuffix = process.platform === 'win32' ? '.exe' : '';

/**
 * The cargo-built (not bundled/installer) binary. Cargo names it after the
 * package, `mindstream-notes`; on Windows it carries the .exe suffix.
 * tauri-driver reads this path to launch the app under WebDriver.
 */
export const appBinary = join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  `mindstream-notes${exeSuffix}`
);

export const tauriDriverPath = join(
  homedir(),
  '.cargo',
  'bin',
  `tauri-driver${exeSuffix}`
);

const tauriScript = join(repoRoot, 'src-tauri', 'scripts', 'tauri.mjs');

const pathEnvKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ??
  'PATH';
const nodeBinDir = dirname(process.execPath);
const inheritedPath = process.env[pathEnvKey];

const buildEnv = {
  ...process.env,
  [pathEnvKey]: inheritedPath
    ? `${nodeBinDir}${delimiter}${inheritedPath}`
    : nodeBinDir,
  NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
  VITE_MINDSTREAM_E2E: '1',
  // pnpm 11 auto-runs `pnpm install` before scripts when it thinks
  // node_modules is stale. The app E2E build is non-interactive, so keep the
  // dependency install as an explicit developer/CI step instead of letting this
  // hook try to purge node_modules.
  pnpm_config_verify_deps_before_run:
    process.env.pnpm_config_verify_deps_before_run ?? 'false'
};

/**
 * A `#[tauri::command]` that only compiles under `--features e2e-data-dir`
 * (src-tauri/src/sharing/invite.rs, registered in lib.rs behind the same cfg).
 * Tauri's generated handler dispatches on the command *name*, so the literal is
 * embedded in the binary if and only if the feature was enabled — verified both
 * ways: present in a `--features e2e-data-dir` build, absent from a plain one.
 *
 * Checking the artifact beats trusting a build stamp: it catches a binary built
 * by any route (a manual `cargo build`, a stale target dir, a colleague's copy),
 * which is exactly the situation MINDSTREAM_E2E_SKIP_BUILD invites.
 */
const FEATURE_MARKER = 'e2e_create_standalone_collection_invite';

/** Does the built binary carry the `e2e-data-dir` feature? */
function hasE2eFeature(binary: string): boolean {
  return readFileSync(binary).includes(FEATURE_MARKER);
}

/**
 * Verify the binary exists and was built with `e2e-data-dir`.
 *
 * Without that feature `profiles::dir_override_allowed()` is false in a release
 * build, so `MINDSTREAM_PROFILE_DIR` is ignored — every client would quietly
 * share the developer's real vault instead of its own temp profile, and the
 * sharing specs' e2e-only IPC commands would not exist.
 */
export function assertAppBinaryReady(): void {
  if (!existsSync(appBinary)) {
    fail(
      `app binary not found at ${appBinary}. Drop MINDSTREAM_E2E_SKIP_BUILD ` +
        `to build it (the suite builds it for you), or run ` +
        `\`node src-tauri/scripts/tauri.mjs build --no-bundle --features e2e-data-dir\`.`
    );
  }
  if (!hasE2eFeature(appBinary)) {
    fail(
      `app binary at ${appBinary} was built WITHOUT \`--features e2e-data-dir\`. ` +
        `MINDSTREAM_PROFILE_DIR is ignored by such a build, so the tests would ` +
        `run against your real vault instead of isolated temp profiles. ` +
        `Re-run without MINDSTREAM_E2E_SKIP_BUILD=1 to rebuild it correctly.`
    );
  }
}

/** Verify tauri-driver is installed before a session tries to spawn it. */
export function assertTauriDriver(): void {
  if (!existsSync(tauriDriverPath)) {
    fail(
      `tauri-driver not found at ${tauriDriverPath}. Install it with ` +
        `\`cargo install tauri-driver --locked\` (see docs/e2e/harness.md#toolchain).`
    );
  }
}

/**
 * Build through the Tauri CLI, not plain Cargo. The CLI runs the frontend build
 * and injects the production asset config; a direct `cargo build` leaves the
 * binary pointing at the dev server, which renders as a blank webview when Vite
 * is not running.
 */
function buildApp(): void {
  // The `--config` overlay empties the config `windows` array so the app
  // creates "main" itself with a per-process WebView2 data directory (see
  // src-tauri/src/lib.rs, gated to the e2e-data-dir feature). Without it every
  // instance shares one user-data-folder, which WebView2 does not support
  // across processes and which makes the multi-client tiers hang at boot.
  const e2eConfig = join(repoRoot, 'src-tauri', 'tauri.e2e.conf.json');
  const res = spawnSync(
    process.execPath,
    [
      tauriScript,
      'build',
      '--no-bundle',
      '--features',
      'e2e-data-dir',
      '--config',
      e2eConfig
    ],
    { cwd: repoRoot, stdio: 'inherit', env: buildEnv }
  );
  if (res.status !== 0) {
    fail('tauri build (--features e2e-data-dir) failed');
  }
}

/**
 * The whole `onPrepare` contract for an app-tier config: assert every
 * requirement, then make sure a correctly-featured binary exists.
 *
 * `MINDSTREAM_E2E_SKIP_BUILD=1` reuses an existing binary instead of rebuilding
 * — but it still has to pass `assertAppBinaryReady()`, so skipping the build can
 * save you time without silently changing what is under test.
 */
export async function preflight({
  backend
}: {
  /** T4 configs: require the collaboration stack to be answering. */
  backend: boolean;
}): Promise<void> {
  assertTauriDriver();
  if (backend) {
    // assertBackendReady throws a plain Error (it is shared with the Playwright
    // tier, where that is the right type); re-wrap so wdio actually aborts.
    await assertBackendReady().catch((err: unknown) =>
      fail(err instanceof Error ? err.message : String(err))
    );
  }

  if (process.env.MINDSTREAM_E2E_SKIP_BUILD === '1') {
    assertAppBinaryReady();
    return;
  }
  buildApp();
  // Also verify what we just produced: a build that silently loses the feature
  // flag is the failure this whole check exists to catch.
  assertAppBinaryReady();
}
