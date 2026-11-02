import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, action = 'dev', ...extra] = process.argv.slice(2);
if (
  !['normal', 'fixtures', 'qa'].includes(mode) ||
  !['dev', 'build'].includes(action)
)
  throw new Error(
    'Usage: node scripts/browser/run.mjs normal|fixtures|qa dev|build [--skip-wasm] [Vite arguments]'
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
let child;
let stopping;
const signals = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
for (const signal of Object.keys(signals)) {
  process.on(signal, () => {
    stopping = signal;
    process.exitCode = signals[signal];
    if (!child?.pid) return;
    // Keep children in the caller's process group so terminal and CI group
    // kills reach them. Forward signals also sent to this launcher alone.
    try {
      if (process.platform === 'win32') {
        const running = child;
        spawn('taskkill', ['/pid', String(running.pid), '/T', '/F']).once(
          'error',
          (error) => {
            console.error(
              'Could not stop the child process tree:',
              error.message
            );
            running.kill(signal);
          }
        );
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
}
async function run(args) {
  if (stopping) return false;
  const code = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  child = undefined;
  process.exitCode = stopping ? signals[stopping] : code;
  return process.exitCode === 0;
}
const skipWasm = extra.includes('--skip-wasm');
const built =
  mode === 'fixtures' ||
  skipWasm ||
  (await run(['scripts/browser/build-wasm.mjs']));
// A failed or interrupted build must not start the server.
if (built && !stopping) {
  const require = createRequire(import.meta.url);
  const vite = resolve(
    dirname(require.resolve('vite/package.json')),
    'bin/vite.js'
  );
  console.log(
    mode === 'qa'
      ? `Browser QA vault: ${testId}. Use Reset test data for a seeded start.`
      : mode === 'fixtures'
        ? 'Browser UI fixtures: note changes are discarded on reload.'
        : 'Storage mode: persistent.'
  );
  await run([
    vite,
    action,
    ...(action === 'dev' &&
    mode !== 'normal' &&
    !extra.some((arg) => arg === '--port' || arg.startsWith('--port='))
      ? ['--port', mode === 'qa' ? '1422' : '1421']
      : []),
    ...extra.filter((arg) => arg !== '--skip-wasm')
  ]);
}
