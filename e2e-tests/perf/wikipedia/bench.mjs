/**
 * Large-vault bench: imports the Wikipedia vault from `make-vault.mjs` into
 * the browser build and times what scales with the vault.
 *
 *   node e2e-tests/perf/wikipedia/bench.mjs [--articles 20000] [--url URL]
 *     [--skip-build] [--headed] [--json results.json] [--profile graph.cpuprofile]
 *
 * Without --url it builds the app (`build:wasm`, `build`) and serves it with
 * `vite preview` on port 1460, so the numbers come from a production bundle.
 * Each run starts from an empty vault in a fresh browser profile.
 *
 * What it reports, in milliseconds unless the name says otherwise:
 *   import            Import pressed → "Import finished"
 *   boot              reload → the imported folder in the file tree
 *   search            query typed → first result
 *   openNote          result clicked → the editor showing the note
 *   localGraph        Local graph opened → its links indexed and drawn
 *   graphTab          Open graph view → the whole vault drawn
 *   graphFrames       frame times while the tab's layout settles (5 s)
 *   graphZoomFrames   frame times while zooming the tab's graph (2 s)
 *   heapMB            JS heap after each step, where Chromium reports it
 *
 * --profile saves a CPU profile of the graphFrames window, which DevTools
 * opens, and prints the functions that took the most time in it. Storage
 * requests slower than half a second are logged as they finish, with their
 * command, and a step that times out leaves a screenshot in .output/.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    articles: { type: 'string', default: '20000' },
    vault: { type: 'string' },
    url: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    json: { type: 'string' },
    profile: { type: 'string' }
  }
});
const PORT = 1460;
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

const vault =
  values.vault ??
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
  ).trim();
const server = values.url
  ? { url: values.url, stop: () => {} }
  : await startServer();

const results = { vault: basename(vault), heapMB: {} };
// A real profile on disk: an ephemeral context keeps OPFS in a small,
// slower store, which a vault this size outgrows. Not in /tmp, which may be
// memory.
const cache = join(homedir(), '.cache', 'mindstream-perf');
await mkdir(cache, { recursive: true });
const profile = await mkdtemp(join(cache, 'profile-'));
const browser = await chromium.launchPersistentContext(profile, {
  headless: !values.headed,
  args: ['--enable-precise-memory-info'],
  viewport: { width: 1600, height: 1000 },
  // Chromium reads picked file paths through the locale.
  env: { ...process.env, LC_ALL: 'C.UTF-8' }
});
try {
  const page = browser.pages()[0] ?? (await browser.newPage());
  page.on('pageerror', (error) => console.error('page error:', error.message));
  page.on('console', (message) => {
    if (message.text().startsWith('[bench]')) console.error(message.text());
  });
  // Time every request to the storage worker; the slow ones say what the
  // vault's size makes expensive.
  await page.addInitScript(() => {
    const Native = Worker;
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
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
          const ms = performance.now() - entry[1];
          if (ms > 500)
            console.log(`[bench] storage ${entry[0]}: ${Math.round(ms)} ms`);
        });
      }
    };
  });
  await page.goto(server.url);
  await page
    .getByRole('button', { name: 'Open settings' })
    .waitFor({ timeout: 120_000 });

  const time = async (name, start, done) => {
    const t0 = performance.now();
    await start();
    try {
      await done();
    } catch (error) {
      await diagnose(page, name);
      throw error;
    }
    results[name] = Math.round(performance.now() - t0);
    results.heapMB[name] = await page.evaluate(() =>
      performance.memory
        ? Math.round(performance.memory.usedJSHeapSize / 1048576)
        : null
    );
    console.error(`${name}: ${results[name]} ms`);
    if (values.json)
      await writeFile(values.json, JSON.stringify(results, null, 2));
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
    () => dialog.getByText('Import finished').waitFor({ timeout: LONG })
  );
  results.importReport = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  const folder = page
    .getByRole('complementary')
    .first()
    .getByText(basename(vault), { exact: true })
    .first();
  await folder.waitFor({ timeout: LONG });

  // Boot with the vault in place.
  await time(
    'boot',
    () => page.reload(),
    () => folder.waitFor({ timeout: LONG })
  );

  // Search, then open the first hit.
  await page.getByRole('button', { name: 'Search notes' }).first().click();
  const search = page.getByPlaceholder('Search notes');
  const hit = page.getByRole('dialog').locator('li button').first();
  await time(
    'search',
    () => search.fill('europe'),
    () => hit.waitFor({ timeout: STEP })
  );
  // Any editor on screen: the vault's first note may be open behind it.
  await time(
    'openNote',
    () => hit.click(),
    () =>
      page.waitForFunction(
        () =>
          [...document.querySelectorAll('.ProseMirror')].some(
            (e) => e.checkVisibility() && (e.textContent?.length ?? 0) > 200
          ),
        null,
        { timeout: STEP }
      )
  );

  // The local graph builds the link index on first use.
  const sidebar = page.getByRole('complementary').first();
  const localGraph = sidebar.locator('[data-graph-state="ready"]');
  await time(
    'localGraph',
    () =>
      sidebar.getByRole('button', { name: 'Local graph', exact: true }).click(),
    () => localGraph.waitFor({ timeout: STEP })
  );
  results.localGraphNodes = Number(
    await localGraph.getAttribute('data-graph-nodes')
  );

  // The whole vault in a tab, with the sidebar back on the file tree so only
  // one graph runs.
  const tabGraph = page.locator('.dv-groupview [data-graph-state="ready"]');
  await time(
    'graphTab',
    () => sidebar.getByRole('button', { name: 'Open graph view' }).click(),
    async () => {
      await tabGraph.waitFor({ timeout: STEP });
      await page.waitForFunction(
        () => {
          const el = document.querySelector(
            '.dv-groupview [data-graph-state="ready"]'
          );
          return Number(el?.getAttribute('data-graph-nodes')) > 0;
        },
        null,
        { timeout: STEP }
      );
    }
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
  // Wheel events from inside the page, and only within the window: input
  // sent through the browser waits for each frame, and a frame of a big
  // graph rasterised in software can take seconds.
  await tabGraph.evaluate((el) => {
    const canvas = el.querySelector('canvas');
    const { left, top, width, height } = canvas.getBoundingClientRect();
    const end = performance.now() + 2000;
    let sent = 0;
    const timer = setInterval(() => {
      if (performance.now() > end || sent === 20) return clearInterval(timer);
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: sent++ < 10 ? -120 : 120,
          clientX: left + width / 2,
          clientY: top + height / 2,
          cancelable: true
        })
      );
    }, 100);
  });
  results.graphZoomFrames = await frames(page, 2000);
} finally {
  await browser.close();
  server.stop();
  await rm(profile, { recursive: true, force: true });
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
  await new Promise((resolve) => setTimeout(resolve, 5000));
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

/** Frame intervals and main-thread long tasks over `ms`. */
function frames(page, ms) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const intervals = [];
        let longTasks = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks += entry.duration;
        });
        observer.observe({ type: 'longtask', buffered: false });
        let last = performance.now();
        const end = last + ms;
        const step = (now) => {
          intervals.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(step);
          else {
            observer.disconnect();
            intervals.sort((a, b) => a - b);
            const at = (q) =>
              Math.round(intervals[Math.floor(q * (intervals.length - 1))]);
            resolve({
              fps: Math.round((intervals.length / ms) * 1000),
              p50: at(0.5),
              p95: at(0.95),
              max: Math.round(intervals[intervals.length - 1]),
              longTaskMs: Math.round(longTasks)
            });
          }
        };
        requestAnimationFrame(step);
      }),
    ms
  );
}

console.log(JSON.stringify(results, null, 2));
if (values.json) await writeFile(values.json, JSON.stringify(results, null, 2));
