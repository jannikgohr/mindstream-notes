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
 * The cargo-built (not bundled/installer) binary. Cargo names it after the
 * package, `mindstream-notes`; on Windows it carries the .exe suffix.
 * tauri-driver reads this path to launch the app under WebDriver.
 */
export const appBinary = join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  `mindstream-notes-e2e-single${exeSuffix}`
);

const cargoAppBinary = join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  `mindstream-notes${exeSuffix}`
);

const tauriConf = join(repoRoot, 'src-tauri', 'tauri.conf.json');

export function appBinaryForProfile(profileId: string): string {
  const safeProfileId = profileId.replace(/[^a-z0-9-]/gi, '-');
  return join(
    repoRoot,
    'src-tauri',
    'target',
    'release',
    `mindstream-notes-e2e-${safeProfileId}${exeSuffix}`
  );
}

export const tauriDriverPath = join(
  homedir(),
  '.cargo',
  'bin',
  `tauri-driver${exeSuffix}`
);

export function spawnTauriDriver(
  args: string[],
  env: NodeJS.ProcessEnv
): ChildProcess {
  const options: SpawnOptions = {
    stdio: [null, process.stdout, process.stderr],
    env
  };
  if (process.platform !== 'win32') {
    options.detached = true;
  }
  return spawn(tauriDriverPath, args, options);
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
 * Build through the Tauri CLI, not plain Cargo. The CLI runs the frontend build
 * and injects the production asset config; a direct `cargo build` leaves the
 * binary pointing at the dev server, which renders as a blank webview when Vite
 * is not running.
 *
 * Multi-client suites need multiple app executables, each with a distinct
 * WebView2 dataDirectory embedded in Tauri's configured window. Runtime
 * MINDSTREAM_PROFILE_DIR isolates SQLite/keyring state, but Tauri's default
 * WebView2 folder remains the fixed OS local-data path for the app identifier;
 * two host processes sharing it can leave one renderer booted as blank/about:blank.
 * Building config variants keeps the normal auto-created window path intact.
 */
function writeE2eConfig(profileId: string): string {
  const baseConfig = JSON.parse(readFileSync(tauriConf, 'utf8')) as {
    app?: {
      windows?: Array<Record<string, unknown>>;
    };
  };
  const mainWindow = baseConfig.app?.windows?.find(
    (window) => window.label === 'main'
  );
  if (!mainWindow) {
    fail('tauri.conf.json does not define a main window');
  }

  const safeProfileId = profileId.replace(/[^a-z0-9-]/gi, '-');
  const configDir = join(repoRoot, '.output', 'tauri-e2e');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, `tauri.${safeProfileId}.conf.json`);
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        $schema: 'https://schema.tauri.app/config/2',
        build: {
          // preflight runs Vite once per suite; profile-specific Tauri
          // builds reuse that `.output/build` instead of rebuilding Vite.
          beforeBuildCommand: ''
        },
        app: {
          windows: [
            {
              ...mainWindow,
              dataDirectory: `mindstream-e2e-webview-${safeProfileId}`
            }
          ]
        }
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

function buildApp(profiles: string[]): void {
  buildFrontend();
  for (const profile of profiles) {
    const e2eConfig = writeE2eConfig(profile);
    const targetBinary = appBinaryForProfile(profile);
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
      fail(`tauri build (--features e2e-data-dir, profile ${profile}) failed`);
    }
    copyFileSync(cargoAppBinary, targetBinary);
    assertAppBinaryReady(targetBinary);
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
  backend,
  buildProfiles = ['single']
}: {
  /** T4 configs: require the collaboration stack to be answering. */
  backend: boolean;
  /** Which per-WebView2-profile app binaries this config needs. */
  buildProfiles?: string[];
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
    for (const profile of buildProfiles) {
      assertAppBinaryReady(appBinaryForProfile(profile));
    }
    return;
  }
  buildApp(buildProfiles);
}
