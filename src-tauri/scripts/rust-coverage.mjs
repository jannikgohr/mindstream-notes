// Rust coverage via cargo-llvm-cov, with a shared ignore-regex + threshold.
//
// Invoked from the `test:coverage:rust` npm script and the CI coverage job
// so the in-scope file set and the 80% line gate stay identical everywhere.
// Spawns cargo with an argv array (no shell) so the regex's |()$ characters
// don't need platform-specific quoting.
//
// Scope mirrors the frontend's coverage scoping (vitest.config.ts): the
// unit metric covers the *logic* layer. Excluded files are integration /
// IPC / UI surfaces proven by e2e and manual testing rather than unit
// tests — Tauri entry/builder glue (lib, main), the system tray and native
// menu UI, global-shortcut + desktop-settings + drawing command shims, the
// PDF render pipeline, the Etebase network sync engine (sync/{mod,repair,
// scheduler,scopes}) and collection-sharing command layer (sharing) and
// network/keyring auth (auth/mod), plus the trivial system/error/i18n shims
// and the migration runner. The pure helpers in these files still have unit
// tests that run; they're just not part of the line-coverage denominator.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IGNORE_REGEX = [
  'sync[/\\\\](mod|repair|scheduler|scopes)\\.rs$',
  'sharing\\.rs$',
  'auth[/\\\\]mod\\.rs$',
  'drawing[/\\\\]mod\\.rs$',
  '(tray|native_menu|hotkeys|desktop_settings|pdf_export|system|error|i18n)\\.rs$',
  '(lib|main)\\.rs$',
  'migrations\\.rs$'
].join('|');

const srcTauri = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Extra args from the caller (e.g. `--lcov --output-path lcov.info` in CI,
// or `--summary-only` locally). Default to a text summary.
const passthrough = process.argv.slice(2);
const reportArgs = passthrough.length > 0 ? passthrough : ['--summary-only'];

const args = [
  'llvm-cov',
  '--locked',
  '--ignore-filename-regex',
  IGNORE_REGEX,
  '--fail-under-lines',
  '80',
  ...reportArgs
];

const result = spawnSync('cargo', args, {
  cwd: srcTauri,
  stdio: 'inherit',
  shell: false
});

process.exit(result.status ?? 1);
