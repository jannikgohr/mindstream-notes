// Rust coverage via cargo-llvm-cov, with a shared ignore-regex.
//
// Invoked from the `test:coverage:rust` npm script and the CI coverage job
// so the in-scope file set stays identical everywhere.
// Spawns cargo with an argv array (no shell) so the regex's |()$ characters
// don't need platform-specific quoting.
//
// Scope mirrors the frontend's coverage scoping (vitest.config.ts): the
// unit metric covers the *logic* layer. Excluded files are integration /
// IPC / UI surfaces proven by e2e and manual testing rather than unit
// tests — Tauri entry/builder glue (lib, main), the system tray and native
// menu UI, global-shortcut + desktop-settings + drawing command shims, the
// PDF render pipeline, backup file orchestration, the Etebase network sync
// engine (sync orchestration/apply/push/pull) and collection-sharing command
// layer (sharing) and network/keyring auth (auth/mod), the supervised
// multi-vault runtime (vault_supervisor: window/tray/quit/handoff
// orchestration against a live Tauri app, exercised by the app-e2e suites)
// and its coordinator OS glue (autostart login registration, signed-update
// installation, cross-process revival leases, window-state views), plus the
// trivial system/error/i18n/path shims and the migration runner. The pure
// helpers in these files still have unit tests that run; they're just not
// part of the line-coverage denominator.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IGNORE_REGEX = [
  'sync[/\\\\](mod|repair|scheduler|scopes|collab_room|collections|local_rows|payloads|pull|push)\\.rs$',
  'sync[/\\\\]apply[/\\\\]',
  'sharing[/\\\\]',
  'backup[/\\\\]',
  'auth[/\\\\]mod\\.rs$',
  'drawing[/\\\\]mod\\.rs$',
  '(tray|native_menu|hotkeys|desktop_settings|pdf_export|system|error|i18n|paths)\\.rs$',
  '(vault_supervisor|vault_window_state)\\.rs$',
  'coordinator_(autostart|updater|revival)\\.rs$',
  '(lib|main)\\.rs$',
  'migrations\\.rs$'
].join('|');

const srcTauri = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Extra args from the caller (e.g. `--lcov --output-path lcov.info` in CI,
// or `--summary-only` locally). Default to a text summary.
const passthrough = process.argv.slice(2);
const reportArgs = passthrough.length > 0 ? passthrough : ['--summary-only'];
const outputPathIndex = reportArgs.indexOf('--output-path');
if (outputPathIndex !== -1 && reportArgs[outputPathIndex + 1]) {
  mkdirSync(
    path.dirname(path.resolve(srcTauri, reportArgs[outputPathIndex + 1])),
    {
      recursive: true
    }
  );
}

const args = [
  'llvm-cov',
  '--locked',
  '--fail-under-lines',
  '80',
  '--ignore-filename-regex',
  IGNORE_REGEX,
  ...reportArgs
];

const result = spawnSync('cargo', args, {
  cwd: srcTauri,
  stdio: 'inherit',
  shell: false
});

// `--lcov` prints no summary, so a threshold failure exits 1 with nothing in
// the log saying what the percentage was. Parse the report we just wrote and
// print the total — no test re-run, same in-scope set by construction.
if (result.status === 0 || result.status === 1) {
  const lcovIndex = reportArgs.indexOf('--lcov');
  if (
    lcovIndex !== -1 &&
    outputPathIndex !== -1 &&
    reportArgs[outputPathIndex + 1]
  ) {
    try {
      const lcov = readFileSync(
        path.resolve(srcTauri, reportArgs[outputPathIndex + 1]),
        'utf8'
      );
      let found = 0;
      let hit = 0;
      for (const line of lcov.split('\n')) {
        const match = /^DA:\d+,(\d+)/.exec(line.trim());
        if (match) {
          found += 1;
          if (Number(match[1]) > 0) hit += 1;
        }
      }
      const pct = found === 0 ? 0 : (100 * hit) / found;
      console.log(
        `Rust line coverage: ${pct.toFixed(2)}% (${hit}/${found}, gate: 80%)`
      );
    } catch {
      // Reporting is best-effort; the gate exit status is what matters.
    }
  }
}

process.exit(result.status ?? 1);
