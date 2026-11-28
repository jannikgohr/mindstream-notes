/**
 * Obsidian on the same vault and steps as ../wikipedia/bench.mjs.
 *
 *   xvfb-run -a -s "-screen 0 1920x1080x24" \
 *     node e2e-tests/perf/competitors/obsidian.mjs [--small | --articles N]
 *     [--graph '{"hideUnresolved":true,"showTags":true}'] [--label NAME]
 *
 * Obsidian reads the vault in place, so there is no import: firstIndex is
 * the first start until its metadata cache is clean. coldIndexed is the same
 * on later starts. searchDone is when the search pane stopped loading.
 * --graph writes .obsidian/graph.json before the first start. Its default
 * graph also draws a node for every link to a missing note; the flags above
 * show what Mindstream's graph shows, notes and tags.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
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
import { app, cache, log, onWindows, save, setup } from './common.mjs';

const { values, vault, label, query } = await setup({
  graph: { type: 'string' },
  label: { type: 'string', default: '' }
});
const { exe, version } = await app('obsidian');
const name = `obsidian-${label}${values.label}`;
const work = join(cache, 'competitors', name);
const copy = join(work, 'vault');
const config = join(work, 'config');
const results = {
  app: `Obsidian ${version}`,
  vault: label,
  platform: process.platform,
  memory: memoryKind,
  graphConfig: values.graph ?? 'default',
  coldStart: [],
  coldIndexed: [],
  heapMB: {},
  pssMB: {}
};

await rm(work, { recursive: true, force: true });
await cp(vault, copy, { recursive: true });
await mkdir(join(config, 'obsidian'), { recursive: true });
await writeFile(
  join(config, 'obsidian', 'obsidian.json'),
  JSON.stringify({
    vaults: { a1b2c3d4e5f60718: { path: copy, ts: Date.now(), open: true } }
  })
);
if (values.graph) {
  await mkdir(join(copy, '.obsidian'), { recursive: true });
  await writeFile(join(copy, '.obsidian', 'graph.json'), values.graph);
}

async function start() {
  // XDG_CONFIG_HOME moves it on Linux, --user-data-dir on Windows.
  const windowsFlags = onWindows(
    `--user-data-dir=${join(config, 'obsidian')}`,
    ...foreground
  );
  const started = await launch(
    exe,
    ['--window-size=1600,1000', ...windowsFlags],
    {
      env: { XDG_CONFIG_HOME: config },
      port: 9333,
      pick: (p) => p.evaluate(() => !!window.app)
    }
  );
  await started.page.setViewportSize({ width: 1600, height: 1000 });
  const t0 = { t0: started.t0 };
  started.tree = await until(
    started.page,
    () => !!document.querySelector('.nav-folder-title, .nav-file-title'),
    null,
    t0
  );
  started.indexed = await until(
    started.page,
    () => window.app.metadataCache.isCacheClean(),
    null,
    t0
  );
  return started;
}

let obsidian = await start();
results.gpu = await gpu(obsidian.page);
results.firstIndex = obsidian.indexed;
log('first index', obsidian.indexed);
await sleep(3000);
results.pssMB.afterImport = pssMB(obsidian.proc.pid);

try {
  for (let i = 0; i < Number(values.runs); i++) {
    await obsidian.close();
    obsidian = await start();
    results.coldStart.push(obsidian.tree);
    results.coldIndexed.push(obsidian.indexed);
    log('cold start', obsidian.tree, obsidian.indexed);
  }
  results.coldStartMedian = median(results.coldStart);
  results.coldIndexedMedian = median(results.coldIndexed);
  const { page } = obsidian;
  await sleep(5000);
  results.pssMB.idle = pssMB(obsidian.proc.pid);
  results.heapMB.idle = await page.evaluate(() =>
    Math.round(performance.memory.usedJSHeapSize / 1048576)
  );

  // Full-text search: the first hit, then the pane done loading.
  await page.evaluate(() =>
    window.app.internalPlugins
      .getPluginById('global-search')
      .instance.openGlobalSearch('')
  );
  const input = page
    .locator(
      '.workspace-leaf-content[data-type="search"] .search-input-container input'
    )
    .first();
  await input.waitFor();
  const s0 = performance.now();
  await input.fill(query);
  results.searchFirst = await until(
    page,
    () => !!document.querySelector('.search-result-file-title'),
    null,
    { t0: s0 }
  );
  results.searchDone = await until(
    page,
    () => {
      const view = window.app.workspace.getLeavesOfType('search')[0]?.view;
      return (
        view &&
        !view.containerEl.querySelector('.is-loading') &&
        !view.dom?.working
      );
    },
    null,
    { t0: s0 }
  );
  log('search', results.searchFirst, results.searchDone);

  const o0 = performance.now();
  await page.locator('.search-result-file-title').first().click();
  results.openNote = await until(
    page,
    () => {
      const leaf = window.app.workspace
        .getLeavesOfType('markdown')
        .find((l) => l.view.file);
      const el = leaf?.view.containerEl.querySelector('.cm-content');
      return (
        !!el?.checkVisibility() &&
        el.textContent.length >= Math.min(100, leaf.view.data.length / 2)
      );
    },
    null,
    { t0: o0 }
  );
  log('open note', results.openNote);

  const drawn = (type) =>
    window.app.workspace.getLeavesOfType(type)[0]?.view.renderer?.nodes.length >
    0;
  const l0 = performance.now();
  await page.evaluate(() =>
    window.app.commands.executeCommandById('graph:open-local')
  );
  results.localGraph = await until(page, drawn, 'localgraph', { t0: l0 });
  await page.evaluate(() =>
    window.app.workspace
      .getLeavesOfType('localgraph')
      .forEach((leaf) => leaf.detach())
  );

  const g0 = performance.now();
  await page.evaluate(() =>
    window.app.commands.executeCommandById('graph:open')
  );
  results.graphTab = await until(page, drawn, 'graph', { t0: g0 });
  Object.assign(
    results,
    await page.evaluate(() => {
      const r = window.app.workspace.getLeavesOfType('graph')[0].view.renderer;
      return { graphNodes: r.nodes.length, graphLinks: r.links.length };
    })
  );
  log('graph', results.graphTab, results.graphNodes, results.graphLinks);
  const tab = '.workspace-leaf-content[data-type="graph"]';
  results.graphFrames = await frames(page, 5000);
  await zoom(page, tab);
  results.graphZoomFrames = await frames(page, 2000);
  results.pssMB.graph = pssMB(obsidian.proc.pid);

  // The renderer stops drawing after 60 frames without layout updates.
  // The deadline runs from opening the graph, as in bench:vault.
  const settle = Number(values.settle) * 1000;
  const settled = await until(
    page,
    () =>
      window.app.workspace.getLeavesOfType('graph')[0].view.renderer
        .idleFrames > 60,
    null,
    { t0: g0, timeout: Math.max(0, g0 + settle - performance.now()) }
  ).catch(() => null);
  results.graphSettled = settled !== null && settled <= settle ? settled : null;
  log('settled', results.graphSettled);
  results.graphLateFrames = await frames(page, 5000);
  await zoom(page, tab);
  results.graphLateZoomFrames = await frames(page, 2000);
  results.pssMB.graphLate = pssMB(obsidian.proc.pid);
  await save(results, values, name);
} finally {
  await obsidian.close();
  await rm(work, { recursive: true, force: true });
}
