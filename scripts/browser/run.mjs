import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, action = 'dev', ...extra] = process.argv.slice(2);
if (!['fixtures', 'qa'].includes(mode) || !['dev', 'build'].includes(action))
  throw new Error(
    'Usage: node scripts/browser/run.mjs fixtures|qa dev|build [Vite arguments]'
  );
const root = fileURLToPath(new URL('../../', import.meta.url));
const testId = mode === 'qa' ? process.env.VITE_BROWSER_TEST_VAULT || 'qa' : '';
if (testId && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(testId))
  throw new Error(
    'Test vault names must use 1 to 48 lowercase letters, digits, or hyphens and start with a letter or digit'
  );
const env = {
  ...process.env,
  VITE_BROWSER_MOCKS: mode === 'fixtures' ? '1' : '0',
  VITE_BROWSER_TEST_VAULT: testId
};
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (mode === 'qa') run(['scripts/browser/build-wasm.mjs']);
const require = createRequire(import.meta.url);
const vite = resolve(
  dirname(require.resolve('vite/package.json')),
  'bin/vite.js'
);
console.log(
  mode === 'qa'
    ? `Browser QA vault: ${testId}. Use Reset test data for a seeded start.`
    : 'Browser UI fixtures: note changes are discarded on reload.'
);
run([
  vite,
  action,
  ...(action === 'dev'
    ? ['--port', mode === 'qa' ? '1422' : '1421', '--strictPort']
    : []),
  ...extra
]);
