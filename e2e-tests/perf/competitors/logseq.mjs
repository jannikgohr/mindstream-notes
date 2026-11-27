/**
 * Logseq (DB graph) on the same vault and steps as ../wikipedia/bench.mjs.
 *
 *   xvfb-run -a -s "-screen 0 1920x1080x24" \
 *     node e2e-tests/perf/competitors/logseq.mjs [--small | --articles N]
 *
 * "File to DB graph" only imports a Logseq file graph, so the vault is
 * copied into one first: logseq/config.edn, the notes under pages/. It also
 * drops top-level paragraphs that aren't list items, so those become
 * bullets, as a Logseq user would have to do. The import stops with an
 * error message if it fails, which 2.0.2 did on every Wikipedia vault tried.
 *
 * Opening a note goes by route, to the page named in PAGE. The graph view
 * starts on tags only; the bench switches it to all pages.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  foreground,
  frames,
  gpu,
  launch,
  median,
  memoryKind,
  pssMB,
  sleep,
  until,
  zoom
} from '../measure.mjs';
import { app, cache, homeEnv, log, save, setup } from './common.mjs';

const { values, vault, label, query } = await setup();
const { exe, version } = await app('logseq');
const PAGE = label === 'small' ? 'Lisbon trip plan' : 'Europe';
const name = `logseq-${label}`;
const work = join(cache, 'competitors', name);
const home = join(work, 'home');
const graph = join(work, `graph-${label}`);
const results = {
  app: `Logseq ${version} (DB graph)`,
  vault: label,
  platform: process.platform,
  memory: memoryKind,
  coldStart: [],
  heapMB: {},
  pssMB: {}
};

function bullets(text) {
  const lines = text.split('\n');
  let i = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0;
  let fence = false;
  let blank = true;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const plain = !/^(#|\s*[-*+] |\s*\d+[.)] |\||>|\s)/.test(line);
    if (!fence && blank && line.trim() && plain) lines[i] = `- ${line}`;
    blank = !line.trim();
  }
  return lines.join('\n');
}

async function convert(from, to) {
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      await convert(join(from, e.name), join(to, e.name));
    } else if (e.name.endsWith('.md')) {
      await mkdir(to, { recursive: true });
      await writeFile(
        join(to, e.name),
        bullets(await readFile(join(from, e.name), 'utf8'))
      );
    }
  }
}

// Logseq keeps its graph list in Electron's home folder, which on Windows
// is the real profile whatever USERPROFILE says. Run only where that
// folder is ours to delete afterwards.
const dotLogseq = process.platform === 'win32' && join(homedir(), '.logseq');
if (dotLogseq && existsSync(dotLogseq))
  throw new Error(`${dotLogseq} exists; the bench would overwrite it`);

await rm(work, { recursive: true, force: true });
await mkdir(home, { recursive: true });
await mkdir(join(graph, 'logseq'), { recursive: true });
await mkdir(join(graph, 'journals'), { recursive: true });
await writeFile(join(graph, 'logseq', 'config.edn'), '{:meta/version 1}\n');
await convert(vault, join(graph, 'pages'));

const start = () =>
  launch(
    exe,
    [
      '--window-size=1600,1000',
      `--user-data-dir=${join(home, 'electron')}`,
      ...foreground
    ],
    {
      env: homeEnv(home),
      port: 9336,
      pick: (p) =>
        p.evaluate(() => !!document.querySelector('#main-content-container'))
    }
  );

// The graph is open when the sidebar names it and the page shows blocks.
const ready = (name) =>
  [...document.querySelectorAll('*')].some(
    (e) => e.childElementCount === 0 && e.textContent.trim() === name
  ) &&
  !!document.querySelector(
    '#main-content-container .ls-block, #main-content-container .ls-page-title'
  );

let logseq = await start();
try {
  let page = logseq.page;
  results.gpu = await gpu(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await until(
    page,
    () => !!document.querySelector('#main-content-container .ls-block')
  );

  await page.evaluate(() => (location.hash = '#/import'));
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('File to DB graph', { exact: true }).click();
  await (await chooser).setFiles(graph);
  const submit = page.getByRole('button', { name: 'Submit' });
  await submit.waitFor();
  const i0 = performance.now();
  await submit.click();
  let peak = 0;
  const sampler = setInterval(
    () => (peak = Math.max(peak, pssMB(logseq.proc.pid) ?? 0)),
    2000
  );
  // It validates the new graph last and says so.
  await until(
    page,
    () => /Your graph is valid|Unexpected error/.test(document.body.innerText),
    null,
    { t0: i0, every: 500, timeout: 4 * 3600_000 }
  );
  clearInterval(sampler);
  results.import = Math.round(performance.now() - i0);
  results.pssMB.importPeak = peak;
  const failed = await page.evaluate(
    () => document.body.innerText.match(/Unexpected error.*/)?.[0]
  );
  if (failed) {
    results.importFailed = failed;
    log('import failed after', results.import, 'ms:', failed);
    await save(results, values, name);
    process.exitCode = 1;
  } else {
    log('import', results.import);
    await sleep(3000);
    results.pssMB.afterImport = pssMB(logseq.proc.pid);

    for (let i = 0; i < Number(values.runs); i++) {
      await logseq.close();
      logseq = await start();
      results.coldStart.push(
        await until(logseq.page, ready, `graph-${label}`, { t0: logseq.t0 })
      );
      log('cold start', results.coldStart.at(-1));
    }
    results.coldStartMedian = median(results.coldStart);
    page = logseq.page;
    await page.setViewportSize({ width: 1600, height: 1000 });
    await sleep(5000);
    results.pssMB.idle = pssMB(logseq.proc.pid);
    results.heapMB.idle = await page.evaluate(() =>
      Math.round(performance.memory.usedJSHeapSize / 1048576)
    );

    // Search dialog: a hit is a highlighted match, not "Create page".
    await page.keyboard.press('Control+k');
    await page.locator('.cp__cmdk').waitFor();
    const s0 = performance.now();
    await page.keyboard.type(query);
    results.searchFirst = await until(
      page,
      () => !!document.querySelector('.cp__cmdk mark'),
      null,
      { t0: s0 }
    );
    log('search', results.searchFirst);
    while (await page.evaluate(() => !!document.querySelector('.cp__cmdk'))) {
      await page.keyboard.press('Escape');
      await sleep(300);
    }

    const o0 = performance.now();
    await page.evaluate(
      (name) =>
        (location.hash = `#/page/${encodeURIComponent(name.toLowerCase())}`),
      PAGE
    );
    results.openNote = await until(
      page,
      () =>
        [...document.querySelectorAll('#main-content-container .ls-block')]
          .map((b) => b.textContent)
          .join('').length > 100,
      null,
      { t0: o0 }
    );
    log('open note', results.openNote);

    await page.evaluate(() => (location.hash = '#/graph'));
    await until(page, () =>
      [...document.querySelectorAll('canvas')].some((c) => c.width > 300)
    );
    // Graph settings sit behind the gear in the bottom left corner.
    await page.mouse.click(36, 964);
    const allPages = page.getByText('All pages', { exact: true });
    await allPages.waitFor();
    const g0 = performance.now();
    await allPages.click();
    results.graphTab = await until(
      page,
      () => Number(document.body.innerText.match(/(\d+) nodes?\b/)?.[1]) > 3,
      null,
      { t0: g0 }
    );
    const counts = await page.evaluate(() =>
      document.body.innerText
        .match(/(\d+) nodes?[\s\S]{0,20}?(\d+) links?/)
        ?.slice(1)
        .map(Number)
    );
    [results.graphNodes, results.graphLinks] = counts ?? [];
    await page.mouse.click(36, 964);
    log('graph', results.graphTab, counts);
    results.graphFrames = await frames(page, 5000);
    await zoom(page, 'body');
    results.graphZoomFrames = await frames(page, 2000);
    results.pssMB.graph = pssMB(logseq.proc.pid);
    // No settle signal to read; look again a minute in.
    await sleep(Math.max(0, 60_000 - (performance.now() - g0)));
    results.graphLateFrames = await frames(page, 5000);
    await zoom(page, 'body');
    results.graphLateZoomFrames = await frames(page, 2000);
    results.pssMB.graphLate = pssMB(logseq.proc.pid);
    await save(results, values, name);
  }
} finally {
  await logseq.close();
  await rm(work, { recursive: true, force: true });
  if (dotLogseq) await rm(dotLogseq, { recursive: true, force: true });
}
