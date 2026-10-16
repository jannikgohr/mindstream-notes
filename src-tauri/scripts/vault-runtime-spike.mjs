// Independent disposable WebView probe. Never launches the production app.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2];
const keepOpen = process.argv.includes('--keep-open');
const skipBuild = process.argv.includes('--skip-build');
if (!['shared', 'isolated'].includes(mode)) {
  throw new Error(
    'Usage: node src-tauri/scripts/vault-runtime-spike.mjs shared|isolated [--keep-open] [--skip-build]'
  );
}
if (!skipBuild) {
  const build = spawnSync(
    'cargo',
    ['build', '--example', 'vault_runtime_spike'],
    {
      cwd: join(repository, 'src-tauri'),
      stdio: 'inherit',
      windowsHide: true
    }
  );
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const parent = join(repository, '.output', 'vault-runtime-spike');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, `${mode}-`));
const binary = join(
  repository,
  'src-tauri',
  'target',
  'debug',
  'examples',
  `vault_runtime_spike${process.platform === 'win32' ? '.exe' : ''}`
);
const children = [];
const environment = { ...process.env };
// A machine-level WebView override would invalidate an explicit directory test.
for (const key of Object.keys(environment)) {
  if (/^WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS)$/i.test(key))
    delete environment[key];
}
writeFileSync(
  join(root, 'environment.json'),
  JSON.stringify(
    {
      platform: process.platform,
      osRelease: release(),
      node: process.version,
      mode,
      removedWebviewOverrides: Object.keys(process.env).filter((key) =>
        /^WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS)$/i.test(key)
      )
    },
    null,
    2
  )
);

function events(vault) {
  try {
    return readFileSync(join(root, `${vault}-events.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}
async function waitFor(vault, predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = children.findLast(
      (entry) => entry.vault === vault
    )?.process;
    const match = events(vault).find(
      (event) => event.pid === current?.pid && predicate(event)
    );
    if (match) return match;
    const child = current;
    if (child?.exitCode != null)
      throw new Error(
        `Worker ${vault} exited ${child.exitCode} before readiness. Evidence: ${root}`
      );
    await delay(100);
  }
  throw new Error(`Worker ${vault} timed out. Evidence: ${root}`);
}
function start(vault) {
  const child = spawn(
    binary,
    ['--root', root, '--vault', vault, '--store', mode],
    {
      cwd: repository,
      env: environment,
      stdio: 'inherit',
      windowsHide: true
    }
  );
  children.push({ vault, process: child });
  child.on('error', (error) => console.error(error));
  return child;
}
function stopOwnedWorkers() {
  for (const child of children) {
    if (child.process.exitCode === null) child.process.kill();
  }
}
process.on('SIGINT', () => {
  stopOwnedWorkers();
  process.exit(130);
});
process.on('SIGTERM', () => {
  stopOwnedWorkers();
  process.exit(143);
});
try {
  start('a');
  const first = await waitFor(
    'a',
    (event) => event.event === 'ready' && event.payload.label === 'main'
  );
  start('b');
  const second = await waitFor(
    'b',
    (event) => event.event === 'ready' && event.payload.label === 'main'
  );
  const expected = mode === 'shared' ? 'a' : null;
  if (first.payload.initial !== null || second.payload.initial !== expected) {
    throw new Error(
      `Unexpected initial markers: a=${first.payload.initial}, b=${second.payload.initial}; expected b=${expected}`
    );
  }
  if (mode === 'shared')
    await waitFor(
      'a',
      (event) => event.event === 'storage' && event.payload.value === 'b'
    );
  await delay(1000);
  if (
    mode === 'isolated' &&
    events('a').some(
      (event) => event.event === 'storage' && event.payload.value === 'b'
    )
  ) {
    throw new Error('Isolated worker observed the other vault marker');
  }
  let browserPids = null;
  if (process.platform === 'win32') {
    const a = await waitFor('a', (event) => event.event === 'browser');
    const b = await waitFor('b', (event) => event.event === 'browser');
    if (!a.payload.browserPid || !b.payload.browserPid) {
      throw new Error('Could not read the WebView2 browser process IDs');
    }
    browserPids = { a: a.payload.browserPid, b: b.payload.browserPid };
    if ((browserPids.a === browserPids.b) !== (mode === 'shared')) {
      throw new Error(
        `Unexpected browser ownership: ${JSON.stringify(browserPids)}`
      );
    }
  }
  const summary = {
    mode,
    browserPids,
    first: first.payload,
    second: second.payload,
    workers: children.map((child) => ({
      vault: child.vault,
      pid: child.process.pid
    }))
  };
  if (!keepOpen) {
    // Terminate just A, leaving B (and its browser) alive. Then verify browser
    // storage survives a worker restart without relying on a shared DB.
    const old = children.find((child) => child.vault === 'a').process;
    const exited = new Promise((done) => old.once('exit', done));
    old.kill();
    await exited;
    start('a');
    const restarted = await waitFor(
      'a',
      (event) => event.event === 'ready' && event.payload.label === 'main'
    );
    if (restarted.payload.initial !== (mode === 'shared' ? 'b' : 'a')) {
      throw new Error(
        `Unexpected restart marker: ${restarted.payload.initial}`
      );
    }
    summary.restart = { pid: restarted.pid, ...restarted.payload };
  }
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ evidence: root, ...summary }, null, 2));
  if (keepOpen) {
    console.log(
      'Probe windows remain open for UI checks. Quit both workers to finish.'
    );
    await Promise.all(
      children.map(
        (child) =>
          new Promise((done) => {
            if (child.process.exitCode !== null) return done();
            child.process.once('exit', done);
          })
      )
    );
  }
} finally {
  stopOwnedWorkers();
}
