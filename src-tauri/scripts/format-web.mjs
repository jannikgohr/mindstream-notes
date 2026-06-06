import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const patterns = [
  'src/**/*.{js,ts,svelte,json,html,css,md}',
  '*.{js,ts,mjs,cjs,json,md,html,css}',
  'docs/**/*.{js,ts,mjs,cjs,json,md,html,css}'
];

const check = process.argv.includes('--check');

const args = [check ? '--check' : '--write', ...patterns];

// Resolve prettier's bin script through require.resolve and run it
// with the current Node binary. We deliberately bypass the
// node_modules/.bin shim: that shim is a `.cmd` file on Windows which
// can't be exec'd directly by spawn(), and falling back to `shell: true`
// trips over spaces in the absolute path on Windows shells. Going
// straight through `prettier/bin/prettier.cjs` sidesteps both issues
// and works uniformly under `pnpm run …`, plain `node …mjs`, and
// husky/lint-staged hooks.
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const prettierBin = require.resolve('prettier/bin/prettier.cjs', {
  paths: [resolve(here, '..', '..')]
});

const result = spawnSync(process.execPath, [prettierBin, ...args], {
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
