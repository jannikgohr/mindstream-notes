// Put a copy of the WIT package inside the SDK before it is packed, so a
// published SDK does not depend on the repository layout. lib/wit.js prefers
// this copy and falls back to ../wit in the repository.

import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'wit');
if (process.argv.includes('--clean')) {
  rmSync(target, { recursive: true, force: true });
} else {
  cpSync(join(root, '..', 'wit'), target, { recursive: true });
}
