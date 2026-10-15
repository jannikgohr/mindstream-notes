/**
 * Server coverage via cargo-llvm-cov.
 *
 *   node backend/server/scripts/coverage.mjs [report args]
 *
 * Invoked from the `test:coverage:server` npm script and the CI server job,
 * so the in-scope file set and the floor are the same everywhere. Extra
 * arguments are passed through as the report (e.g. `--lcov --output-path
 * lcov.info` in CI); the default is a text summary.
 *
 * Unlike the app's metric (src-tauri/scripts/rust-coverage.mjs), this counts
 * the integration tests in tests/ as well as the unit tests. They start the
 * server inside the test process, so every line they reach is counted, and
 * they are where most of the server is tested. It also means a run needs the
 * Postgres the tests need; see the server README.
 *
 * Left out: main.rs (argument parsing and process setup), test_reset.rs (a
 * debug-only route the conformance run exercises) and testing.rs (the
 * database helper for unit tests).
 *
 * The floor ratchets. It sits a round number under the measured one (94.19%
 * when it was set to 90), so a change that drops coverage noticeably fails,
 * and goes up when tests are added.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOOR = '90';

const IGNORE_REGEX = '(main|test_reset|testing)\\.rs$';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const passthrough = process.argv.slice(2);
const reportArgs = passthrough.length > 0 ? passthrough : ['--summary-only'];
const outputPathIndex = reportArgs.indexOf('--output-path');
if (outputPathIndex !== -1 && reportArgs[outputPathIndex + 1]) {
  mkdirSync(dirname(resolve(serverDir, reportArgs[outputPathIndex + 1])), {
    recursive: true
  });
}

// An argv array, not a shell, so the regex needs no platform quoting.
const result = spawnSync(
  'cargo',
  [
    'llvm-cov',
    '--locked',
    '--fail-under-lines',
    FLOOR,
    '--ignore-filename-regex',
    IGNORE_REGEX,
    ...reportArgs
  ],
  { cwd: serverDir, stdio: 'inherit', shell: false }
);

process.exit(result.status ?? 1);
