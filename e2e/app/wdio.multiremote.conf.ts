/**
 * WebdriverIO **multiremote** config for the T4 two-client tier — the seam the
 * collaboration + sharing specs (docs/e2e-strategy.md §5, §7) need but the
 * single-client wdio.conf.ts can't provide. A single `tauri-driver` process
 * hosts exactly one app, so two clients means **two** tauri-driver processes on
 * distinct ports, each launching the app against its own MINDSTREAM_PROFILE_DIR.
 * wdio multiremote then drives both as `browserA` (sender / device A) and
 * `browserB` (recipient / device B).
 *
 * Run with the backend stack up:
 *   pnpm backend:test:up
 *   MINDSTREAM_E2E_APP=1 MINDSTREAM_E2E_BACKEND=1 \
 *     MINDSTREAM_E2E_BACKEND_URL=http://localhost:18080 pnpm test:e2e:app:multi
 *
 * Only specs that need two clients belong here (sharing.e2e.ts, collab.e2e.ts);
 * the single-client T3 specs stay on wdio.conf.ts.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

const binaryName =
  process.platform === 'win32' ? 'mindstream-notes.exe' : 'mindstream-notes';
const application = join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  binaryName
);
const tauriScript = join(repoRoot, 'src-tauri', 'scripts', 'tauri.mjs');

const tauriDriverPath = join(
  homedir(),
  '.cargo',
  'bin',
  process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver'
);
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
  // pnpm 11 auto-runs `pnpm install` before scripts when it thinks
  // node_modules is stale. The app E2E build is non-interactive, so keep the
  // dependency install as an explicit developer/CI step instead of letting this
  // hook try to purge node_modules.
  pnpm_config_verify_deps_before_run:
    process.env.pnpm_config_verify_deps_before_run ?? 'false'
};

/**
 * One tauri-driver process per client. `port` is what wdio connects to;
 * `nativePort` is the underlying WebKitWebDriver — every value must be unique
 * across the two so the processes don't fight over a socket. `profileDir` is a
 * fresh, throwaway data dir (the `dir_override` seam, e2e-data-dir feature) so
 * the two clients are fully isolated on disk.
 */
interface ClientProc {
  port: number;
  nativePort: number;
  profileId: string;
  profileDir: string;
  driver?: ChildProcess;
}

const clients: Record<'browserA' | 'browserB', ClientProc> = {
  browserA: {
    port: 4444,
    nativePort: 4445,
    profileId: 'e2e-a',
    profileDir: mkdtempSync(join(tmpdir(), 'mindstream-e2e-a-'))
  },
  browserB: {
    port: 4446,
    nativePort: 4447,
    profileId: 'e2e-b',
    profileDir: mkdtempSync(join(tmpdir(), 'mindstream-e2e-b-'))
  }
};

function spawnDriver(client: ClientProc): ChildProcess {
  return spawn(
    tauriDriverPath,
    ['--port', String(client.port), '--native-port', String(client.nativePort)],
    {
      stdio: [null, process.stdout, process.stderr],
      // The launched app reads its data dir from here — this is what makes
      // the two clients distinct users' devices. The profile id namespaces the
      // OS keyring entry; without it both clients default to `e2e`.
      env: {
        ...process.env,
        MINDSTREAM_PROFILE_DIR: client.profileDir,
        MINDSTREAM_PROFILE_ID: client.profileId
      }
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
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },

  // Same Tauri-CLI build as the single-client config: a plain `cargo build`
  // leaves the binary pointing at the dev server (blank webview). Skip with
  // MINDSTREAM_E2E_SKIP_BUILD=1 after a good build while iterating.
  onPrepare: () => {
    if (process.env.MINDSTREAM_E2E_SKIP_BUILD === '1') return;
    const res = spawnSync(
      process.execPath,
      [tauriScript, 'build', '--no-bundle', '--features', 'e2e-data-dir'],
      { cwd: repoRoot, stdio: 'inherit', env: buildEnv }
    );
    if (res.status !== 0) {
      throw new Error('tauri build (--features e2e-data-dir) failed');
    }
  },

  // Bring up both tauri-driver processes before the multiremote session opens,
  // each pinned to its own profile dir and ports.
  beforeSession: () => {
    for (const client of Object.values(clients)) {
      if (!client.driver) client.driver = spawnDriver(client);
    }
  },

  afterSession: () => {
    for (const client of Object.values(clients)) {
      client.driver?.kill();
      client.driver = undefined;
    }
  }
};
