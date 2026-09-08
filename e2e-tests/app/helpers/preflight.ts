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

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions
} from 'node:child_process';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
 * The cargo-built (not bundled/installer) binary, copied aside under an e2e
 * name so an ordinary `cargo build` can't quietly replace what
 * `MINDSTREAM_E2E_SKIP_BUILD=1` then reuses. tauri-driver reads this path to
 * launch the app under WebDriver.
 *
 * One binary serves every client of every suite — see `buildApp`.
 */
export const appBinary = join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  `mindstream-notes-e2e${exeSuffix}`
);

const cargoAppBinary = join(
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

/**
 * Launch tauri-driver, optionally teeing its output to a file.
 *
 * The driver's stdio carries the *app's* too — Rust `tracing` output, GTK and
 * WebKit warnings, and any panic that gets past the catch_unwind seams. Left
 * on the console it interleaves with every other worker's, which makes it
 * near-unreadable in CI; `logPath` keeps a per-suite copy next to the failure
 * artifacts while the console still sees everything it saw before.
 */
export function spawnTauriDriver(
  args: string[],
  env: NodeJS.ProcessEnv,
  logPath?: string
): ChildProcess {
  const options: SpawnOptions = {
    stdio: logPath
      ? [null, 'pipe', 'pipe']
      : [null, process.stdout, process.stderr],
    env
  };
  if (process.platform !== 'win32') {
    options.detached = true;
  }
  const child = spawn(tauriDriverPath, args, options);
  if (!logPath) return child;

  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const tee = (chunk: Buffer, mirror: NodeJS.WriteStream) => {
    mirror.write(chunk);
    log.write(chunk);
  };
  child.stdout?.on('data', (chunk: Buffer) => tee(chunk, process.stdout));
  child.stderr?.on('data', (chunk: Buffer) => tee(chunk, process.stderr));
  // The driver outliving the stream is normal (it is killed on teardown); a
  // write to a closed stream must not take the run down with it.
  log.on('error', (error) =>
    console.warn(`[preflight] driver log write failed (${logPath}):`, error)
  );
  child.once('close', () => log.end());
  return child;
}

const tauriScript = join(repoRoot, 'src-tauri', 'scripts', 'tauri.mjs');
const viteScript = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');

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
export function assertAppBinaryReady(binary = appBinary): void {
  if (!existsSync(binary)) {
    fail(
      `app binary not found at ${binary}. Drop MINDSTREAM_E2E_SKIP_BUILD ` +
        `to build it (the suite builds it for you), or run ` +
        `\`node src-tauri/scripts/tauri.mjs build --no-bundle --features e2e-data-dir\`.`
    );
  }
  if (!hasE2eFeature(binary)) {
    fail(
      `app binary at ${binary} was built WITHOUT \`--features e2e-data-dir\`. ` +
        `MINDSTREAM_PROFILE_DIR is ignored by such a build, so the tests would ` +
        `run against your real vault instead of isolated temp profiles. ` +
        `Re-run without MINDSTREAM_E2E_SKIP_BUILD=1 to rebuild it correctly.`
    );
  }
}

/**
 * Delete leftover `mindstream-e2e-*` profile dirs from earlier runs.
 *
 * Each config mints a throwaway profile dir per client with `mkdtempSync` and
 * nothing ever removed them, so they pile up in the temp dir indefinitely (the
 * investigation left ~1000). The current run's dirs are seconds old — created
 * at config module-load, just before this runs — so an age cutoff never touches
 * them. Best-effort: a dir held open by a still-dying process just survives to
 * the next sweep. Runs are sequential (maxInstances 1), so nothing else is
 * using an old dir.
 */
export function sweepStaleProfileDirs(maxAgeMs = 30 * 60_000): void {
  const root = tmpdir();
  const cutoff = Date.now() - maxAgeMs;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('mindstream-e2e-')) continue;
    const full = join(root, name);
    try {
      if (statSync(full).mtimeMs > cutoff) continue;
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* in use or already gone — next sweep gets it */
    }
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

function waitForExit(
  driver: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (driver.exitCode !== null || driver.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const done = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      driver.off('exit', done);
      driver.off('error', done);
    };
    driver.once('exit', done);
    driver.once('error', done);
  });
}

/**
 * Stop tauri-driver and the native/app descendants it launched.
 *
 * The T3/T4 configs reuse fixed WebDriver/native ports for each fresh session.
 * A plain `child.kill()` only signals tauri-driver itself, which can leave
 * msedgedriver/WebView2/app descendants alive long enough for the next session
 * to connect to a half-closing driver. That is the transport face of the flake
 * captured as `UND_ERR_HEADERS_TIMEOUT` plus tauri-driver's
 * `hyper::Error(IncompleteMessage)`.
 */
export async function stopTauriDriverTree(
  driver: ChildProcess | undefined,
  timeoutMs = 10_000
): Promise<void> {
  const pid = driver?.pid;
  if (!driver || !pid) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore'
    });
    await waitForExit(driver, timeoutMs);
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      driver.kill('SIGTERM');
    } catch {
      return;
    }
  }
  if (await waitForExit(driver, timeoutMs)) return;

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      driver.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await waitForExit(driver, timeoutMs);
}

/**
 * A `--config` overlay that stops the Tauri CLI running the frontend build.
 *
 * `buildFrontend()` already ran Vite with the e2e env (`VITE_MINDSTREAM_E2E`),
 * and the CLI's own `beforeBuildCommand` would just repeat it.
 */
function writeE2eBuildConfig(): string {
  const configDir = join(repoRoot, '.output', 'tauri-e2e');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'tauri.e2e.conf.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        $schema: 'https://schema.tauri.app/config/2',
        build: { beforeBuildCommand: '' }
      },
      null,
      2
    )
  );
  return configPath;
}

function buildFrontend(): void {
  const res = spawnSync(process.execPath, [viteScript, 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: buildEnv
  });
  if (res.error) {
    fail(`frontend build failed to start: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const reason =
      res.status === null
        ? `terminated by ${res.signal ?? 'unknown signal'}`
        : `exited with status ${res.status}`;
    fail(`frontend build (\`vite build\`) failed: ${reason}`);
  }
}

/**
 * Build through the Tauri CLI, not plain Cargo. The CLI injects the production
 * asset config; a direct `cargo build` leaves the binary pointing at the dev
 * server, which renders as a blank webview when Vite is not running.
 *
 * One build, reused by every client. The multi-client suites used to compile a
 * binary each, differing only in the window's `dataDirectory` — meant to give
 * each client its own WebView store, since that store sits outside the
 * `MINDSTREAM_PROFILE_DIR` the rest of the isolation goes through.
 *
 * It never did anything. `impl From<&WindowConfig> for WebviewAttributes`
 * (tauri-runtime 2.11.1) does not copy `data_directory`, so for a window Tauri
 * creates from config the value is dropped and the manager falls back to
 * `<local data dir>/<identifier>` for every process. Verified by launching the
 * built binary directly: the override reached the config and the directory was
 * still never created. So the extra builds bought four extra cargo compiles
 * and identical behaviour.
 */
function buildApp(): void {
  buildFrontend();
  const res = spawnSync(
    process.execPath,
    [
      tauriScript,
      'build',
      '--no-bundle',
      '--features',
      'e2e-data-dir',
      '--config',
      writeE2eBuildConfig()
    ],
    { cwd: repoRoot, stdio: 'inherit', env: buildEnv }
  );
  if (res.status !== 0) {
    fail('tauri build (--features e2e-data-dir) failed');
  }
  copyFileSync(cargoAppBinary, appBinary);
  assertAppBinaryReady(appBinary);
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
  sweepStaleProfileDirs();
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
}
