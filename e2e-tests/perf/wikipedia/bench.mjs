/**
 * Large-vault bench: imports the Wikipedia vault from `make-vault.mjs` into
 * the browser build and times what scales with the vault.
 *
 *   node e2e-tests/perf/wikipedia/bench.mjs [--articles 20000] [--small]
 *     [--vault DIR --query TEXT] [--url URL] [--skip-build] [--headed]
 *     [--runs 3] [--settle 300] [--json results.json]
 *     [--profile graph.cpuprofile]
 *
 * Without --url it builds the app (`build:wasm`, `build`) and serves it with
 * `vite preview` on port 1460, so the numbers come from a production bundle.
 * Each run starts from an empty vault in a fresh browser profile. Chromium
 * runs as its own process, started and quit like an app, so cold starts and
 * memory compare with the Electron apps in ../competitors/.
 *
 * --small imports the 28-note vault in ../fixtures/small-vault instead and
 * searches it for "lisbon". --vault imports any folder; give it a --query
 * that matches some of its notes.
 *
 * What it reports, in milliseconds unless the name says otherwise:
 *   import             Import pressed → "Import finished"
 *   coldStart          browser started → the imported folder in the file
 *                      tree, once per --runs; coldStartMedian is the median
 *   searchFirst        query typed → first result
 *   openNote           result clicked → the editor showing the note
 *   localGraph         Local graph opened → its links indexed and drawn
 *   graphTab           Open graph view → the whole vault drawn
 *   graphFrames        frame times while the tab's layout settles (5 s)
 *   graphZoomFrames    frame times while zooming the tab's graph (2 s)
 *   graphSettled       Open graph view → the layout worker's last update,
 *                      null if it was still moving after --settle seconds
 *   graphLateFrames    frame times once settled, or after --settle (5 s)
 *   graphLateZoomFrames  the same while zooming (2 s)
 *   heapMB             JS heap after each step, where Chromium reports it
 *   pssMB              memory of the whole browser process tree (Linux)
 *   slowStorage        storage requests over 100 ms, with their command
 *
 * --profile saves a CPU profile of the graphFrames window, which DevTools
 * opens, and prints the functions that took the most time in it. Storage
 * requests slower than half a second are logged as they finish, and a step
 * that times out leaves a screenshot in .output/.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  chromium,
  frames,
  launch,
  median,
  pssMB,
  sleep,
  until,
  zoom
} from '../measure.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    articles: { type: 'string', default: '20000' },
    small: { type: 'boolean', default: false },
    vault: { type: 'string' },
    query: { type: 'string' },
    url: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    runs: { type: 'string', default: '3' },
    settle: { type: 'string', default: '300' },
    json: { type: 'string' },
    profile: { type: 'string' }
  }
});
const PORT = 1460;
const CDP_PORT = 9334;
// Import and boot scale with the vault; anything else this slow is a hang.
const LONG = 30 * 60_000;
const STEP = 5 * 60_000;

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit']
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    );
  });
}

async function startServer() {
  if (!values['skip-build']) {
    await run('pnpm', ['build:wasm']);
    await run('pnpm', ['build']);
  }
  // Vite itself rather than `pnpm preview`, so stopping it stops the server.
  const server = spawn(
    process.execPath,
    [
      join(root, 'node_modules/vite/bin/vite.js'),
      'preview',
      '--port',
      String(PORT),
      '--strictPort'
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  process.on('exit', () => server.kill());
  await new Promise((resolve, reject) => {
    server.once('close', (code) =>
      reject(new Error(`vite preview exited with ${code}`))
    );
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`:${PORT}`)) resolve();
    });
  });
  return { url: `http://localhost:${PORT}/`, stop: () => server.kill() };
}

const vault = values.small
  ? fileURLToPath(new URL('../fixtures/small-vault', import.meta.url))
  : (values.vault ??
    (
      await run(
        process.execPath,
        [
          join(root, 'e2e-tests/perf/wikipedia/make-vault.mjs'),
          '--articles',
          values.articles
        ],
        { capture: true }
      )
    ).trim());
const query = values.query ?? (values.small ? 'lisbon' : 'europe');
const server = values.url
  ? { url: values.url, stop: () => {} }
  : await startServer();

const results = {
  vault: basename(vault),
  query,
  coldStart: [],
  heapMB: {},
  pssMB: {}
};
const save = () =>
  values.json && writeFile(values.json, JSON.stringify(results, null, 2));

// Times every storage request, and the graph layout worker's last update:
// it stops posting once its layout has settled.
function instrument() {
  const Native = window.Worker;
  window.__bench = { storage: [], layoutAt: 0, layoutMessages: 0 };
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes('graph-layout'))
        this.addEventListener('message', () => {
          window.__bench.layoutAt = performance.now();
          window.__bench.layoutMessages++;
        });
      if (!String(url).includes('sqlite')) return;
      const started = new Map();
      const post = this.postMessage.bind(this);
      this.postMessage = (message, transfer) => {
        const what = message?.args?.command ?? message?.method;
        started.set(message?.id, [what, performance.now()]);
        return post(message, transfer);
      };
      this.addEventListener('message', ({ data }) => {
        const entry = started.get(data?.id);
        if (!entry) return;
        started.delete(data.id);
        const ms = Math.round(performance.now() - entry[1]);
        if (ms > 100) window.__bench.storage.push(`${entry[0]} ${ms}`);
        if (ms > 500) console.log(`[bench] storage ${entry[0]}: ${ms} ms`);
      });
    }
  };
}

// A real profile on disk: an ephemeral context keeps OPFS in a small,
// slower store, which a vault this size outgrows. Not in /tmp, which may be
// memory.
const cache = join(homedir(), '.cache', 'mindstream-perf');
await mkdir(cache, { recursive: true });
const profile = await mkdtemp(join(cache, 'profile-'));

async function start() {
  // Chrome for Testing restores the last session's tabs, and a second tab
  // of the app waits for the first to release the database.
  await rm(join(profile, 'Default', 'Sessions'), {
    recursive: true,
    force: true
  });
  const app = await launch(
    chromium.executablePath(),
    [
      `--user-data-dir=${profile}`,
      ...(values.headed ? [] : ['--headless=new']),
      '--no-first-run',
      '--no-default-browser-check',
      // Without it Chromium waits about 25 s for the system keyring.
      '--password-store=basic',
      '--enable-precise-memory-info',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--window-size=1600,1000',
      'about:blank'
    ],
    { port: CDP_PORT, cdpClose: true }
  );
  const { page } = app;
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.on('pageerror', (error) => console.error('page error:', error.message));
  page.on('console', (message) => {
    if (message.text().startsWith('[bench]')) console.error(message.text());
  });
  await page.context().addInitScript(instrument);
  await page.goto(server.url);
  return app;
}

const treeShows = (name) =>
  [...document.querySelectorAll('aside *, [role="complementary"] *')].some(
    (e) =>
      e.childElementCount === 0 && e.textContent === name && e.checkVisibility()
  );

let app = await start();
try {
  let page = app.page;
  await page
    .getByRole('button', { name: 'Open settings' })
    .waitFor({ timeout: 120_000 });

  // `done` runs in the page and is polled like the competitor benches poll.
  const time = async (name, begin, done, timeout = STEP) => {
    const t0 = performance.now();
    await begin();
    try {
      results[name] = await until(page, done, null, { t0, timeout });
    } catch (error) {
      await diagnose(page, name);
      throw error;
    }
    results.heapMB[name] = await heap(page);
    console.error(`${name}: ${results[name]} ms`);
    await save();
  };

  // Import.
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: /^Data/ }).first().click();
  await settings
    .getByRole('button', { name: 'Import notes', exact: true })
    .click();
  const dialog = page.getByRole('alertdialog');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByRole('button', { name: /Choose a folder/ }).click()
  ]);
  await chooser.setFiles(vault);
  await time(
    'import',
    () => dialog.getByRole('button', { name: 'Import', exact: true }).click(),
    () =>
      [...document.querySelectorAll('[role="alertdialog"]')].some((d) =>
        d.textContent.includes('Import finished')
      ),
    LONG
  );
  results.importReport = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await until(page, treeShows, basename(vault), { timeout: LONG });
  await sleep(3000);
  results.pssMB.afterImport = pssMB(app.proc.pid);

  // Cold starts with the vault in place.
  for (let i = 0; i < Number(values.runs); i++) {
    await app.close();
    app = await start();
    results.coldStart.push(
      await until(app.page, treeShows, basename(vault), {
        t0: app.t0,
        timeout: LONG
      })
    );
    console.error(`coldStart: ${results.coldStart.at(-1)} ms`);
  }
  results.coldStartMedian = median(results.coldStart);
  page = app.page;
  await sleep(5000);
  results.heapMB.idle = await heap(page);
  results.pssMB.idle = pssMB(app.proc.pid);
  await save();

  // Search, then open the first hit.
  await page.getByRole('button', { name: 'Search notes' }).first().click();
  const search = page.getByPlaceholder('Search notes');
  const hit = page.getByRole('dialog').locator('li button').first();
  await time(
    'searchFirst',
    () => search.fill(query),
    () => !!document.querySelector('[role="dialog"] li button')
  );
  // Any editor on screen: the vault's first note may be open behind it.
  await time(
    'openNote',
    () => hit.click(),
    () =>
      [...document.querySelectorAll('.ProseMirror')].some(
        (e) => e.checkVisibility() && (e.textContent?.length ?? 0) > 100
      )
  );

  // The local graph builds the link index on first use.
  const sidebar = page.getByRole('complementary').first();
  const localGraph = sidebar.locator('[data-graph-state="ready"]');
  await time(
    'localGraph',
    () =>
      sidebar.getByRole('button', { name: 'Local graph', exact: true }).click(),
    () =>
      !!document.querySelector(
        'aside [data-graph-state="ready"], [role="complementary"] [data-graph-state="ready"]'
      )
  );
  results.localGraphNodes = Number(
    await localGraph.getAttribute('data-graph-nodes')
  );

  // The whole vault in a tab, with the sidebar back on the file tree so only
  // one graph runs.
  const tabGraph = page.locator('.dv-groupview [data-graph-state="ready"]');
  const opened = await page.evaluate(() => performance.now());
  await time(
    'graphTab',
    () => sidebar.getByRole('button', { name: 'Open graph view' }).click(),
    () =>
      Number(
        document
          .querySelector('.dv-groupview [data-graph-state="ready"]')
          ?.getAttribute('data-graph-nodes')
      ) > 0
  );
  await sidebar.getByRole('button', { name: 'Home', exact: true }).click();
  results.graphNodes = Number(await tabGraph.getAttribute('data-graph-nodes'));
  results.graphLinks = Number(await tabGraph.getAttribute('data-graph-links'));

  const cdp = values.profile ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  results.graphFrames = await frames(page, 5000);
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(values.profile, JSON.stringify(profile));
    printHotspots(profile);
  }
  await zoom(page, '.dv-groupview');
  results.graphZoomFrames = await frames(page, 2000);
  results.pssMB.graph = pssMB(app.proc.pid);

  // Settled: the layout worker has been quiet for a second.
  const settledAt = await until(
    page,
    () =>
      window.__bench.layoutMessages > 0 &&
      performance.now() - window.__bench.layoutAt > 1000,
    null,
    { timeout: Number(values.settle) * 1000 }
  )
    .then(() => page.evaluate(() => window.__bench.layoutAt))
    .catch(() => null);
  results.graphSettled =
    settledAt === null ? null : Math.round(settledAt - opened);
  console.error(`graphSettled: ${results.graphSettled} ms`);
  results.graphLateFrames = await frames(page, 5000);
  await zoom(page, '.dv-groupview');
  results.graphLateZoomFrames = await frames(page, 2000);
  results.heapMB.graphLate = await heap(page);
  results.pssMB.graphLate = pssMB(app.proc.pid);
  results.slowStorage = await page.evaluate(() => window.__bench.storage);
} finally {
  await app.close();
  server.stop();
  await rm(profile, { recursive: true, force: true });
}

function heap(page) {
  return page.evaluate(() =>
    performance.memory
      ? Math.round(performance.memory.usedJSHeapSize / 1048576)
      : null
  );
}

/** What the page was doing when a step timed out: a screenshot and the
 * functions busy in the next few seconds. */
async function diagnose(page, step) {
  const shot = join(root, '.output', `bench-vault-${step}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  console.error(`${step} did not finish; screenshot in ${shot}`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await sleep(5000);
  printHotspots((await cdp.send('Profiler.stop')).profile);
}

/** The functions with the most self time in a CPU profile. */
function printHotspots(profile) {
  const self = new Map();
  const interval =
    (profile.endTime - profile.startTime) / Math.max(profile.samples.length, 1);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const id of profile.samples) {
    const { callFrame: f } = byId.get(id);
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + interval / 1000);
  }
  console.error('Most self time:');
  for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 15))
    console.error(`  ${ms.toFixed(0).padStart(6)} ms  ${key}`);
}

console.log(JSON.stringify(results, null, 2));
await save();
