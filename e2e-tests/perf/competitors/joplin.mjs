/**
 * Joplin on the same vault and steps as ../wikipedia/bench.mjs, up to
 * opening a note: it has no graph view.
 *
 *   xvfb-run -a -s "-screen 0 1920x1080x24" \
 *     node e2e-tests/perf/competitors/joplin.mjs [--small | --articles N]
 *
 * Imports with "MD - Markdown (Directory)", which keeps front matter as text
 * rather than tags. Search finds nothing until a background job has put the
 * notes in Joplin's full-text index; searchIndexed is the time from the
 * import finishing until its log says every note is in.
 *
 * Joplin exits on start flags it doesn't know, Playwright's --inspect
 * included, so the main process is reached through the Node inspector that
 * SIGUSR1 opens (process._debugProcess on Windows), the way Joplin's own
 * Playwright tests stub the file picker. HOME (USERPROFILE on Windows) and
 * --user-data-dir point at a scratch directory, so the real profile is
 * never touched.
 */
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  gpu,
  launch,
  median,
  memoryKind,
  pssMB,
  sleep,
  until
} from '../measure.mjs';
import { app, cache, homeEnv, log, save, setup } from './common.mjs';

const { values, vault, label, query } = await setup();
const { exe, version } = await app('joplin');
const name = `joplin-${label}`;
const work = join(cache, 'competitors', name);
const home = join(work, 'home');
const copy = join(work, basename(vault));
const results = {
  app: `Joplin ${version}`,
  vault: label,
  platform: process.platform,
  memory: memoryKind,
  coldStart: [],
  heapMB: {},
  pssMB: {}
};

await rm(work, { recursive: true, force: true });
await mkdir(home, { recursive: true });
await cp(vault, copy, { recursive: true });

/** Evaluates `expression` in Joplin's main process. */
async function main(joplin, expression) {
  // What SIGUSR1 does on Linux; Windows has no such signal.
  if (process.platform === 'win32') process._debugProcess(joplin.proc.pid);
  else process.kill(joplin.proc.pid, 'SIGUSR1');
  let targets;
  for (let i = 0; i < 50 && !Array.isArray(targets); i++) {
    targets = await fetch('http://127.0.0.1:9229/json/list')
      .then((r) => r.json())
      .catch(() => null);
    if (!Array.isArray(targets)) await sleep(100);
  }
  if (!Array.isArray(targets)) throw new Error('no inspector on 9229');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const reply = new Promise((r) =>
    ws.addEventListener('message', (m) => r(JSON.parse(m.data)))
  );
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    })
  );
  const { result } = await reply;
  ws.close();
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
  return result.result.value;
}

async function start() {
  // On Windows its Electron data, and the single-instance lock with it,
  // would stay in %APPDATA% beside a Joplin you may have open.
  const userData = `--user-data-dir=${join(home, 'electron')}`;
  const joplin = await launch(exe, ['--no-welcome', userData], {
    env: homeEnv(home),
    port: 9335,
    pick: (p) => p.evaluate(() => document.title.startsWith('Joplin'))
  });
  await joplin.page.setViewportSize({ width: 1600, height: 1000 });
  // After a SIGTERM its profile lock stays behind and the next start exits
  // at once, so quit through the main process.
  joplin.close = async () => {
    await joplin.browser.close().catch(() => {});
    await main(joplin, "process.mainModule.require('electron').app.quit()");
    if (joplin.proc.exitCode === null && joplin.proc.signalCode === null)
      await new Promise((r) => joplin.proc.once('exit', r));
  };
  return joplin;
}

const inSidebar = (name) =>
  [...document.querySelectorAll('.sidebar *, [class*="sidebar"] *')].some(
    (e) =>
      e.childElementCount === 0 &&
      e.textContent.trim() === name &&
      e.checkVisibility()
  );

let joplin = await start();
try {
  let page = joplin.page;
  results.gpu = await gpu(page);
  await until(page, () => document.body.innerText.includes('All notes'));

  const imported = new Promise((resolve) =>
    page.on(
      'console',
      (m) => m.text().includes('Import result') && resolve(m.text())
    )
  );
  const item = await main(
    joplin,
    `(() => {
      const { dialog, Menu } = process.mainModule.require('electron');
      const path = ${JSON.stringify(copy)};
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showOpenDialogSync = () => [path];
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      dialog.showMessageBoxSync = () => 0;
      const find = (items, parent) => {
        for (const item of items) {
          if (parent === 'Import' && /^MD - Markdown \\(Directory\\)/.test(item.label))
            return item.click(), item.label;
          const hit = item.submenu && find(item.submenu.items, item.label);
          if (hit) return hit;
        }
      };
      return find(Menu.getApplicationMenu().items, '') ?? null;
    })()`
  );
  // Timed from the click's reply, a few ms after the import starts.
  const i0 = performance.now();
  if (!item) throw new Error('no "MD - Markdown (Directory)" import item');
  await imported;
  results.import = Math.round(performance.now() - i0);
  log('import', results.import);

  const notes = async function count(dir) {
    let n = 0;
    for (const e of await readdir(dir, { withFileTypes: true }))
      if (e.isDirectory()) n += await count(join(dir, e.name));
      else if (e.name.endsWith('.md')) n++;
    return n;
  };
  const expected = await notes(copy);
  const indexed = async () =>
    [
      ...(
        await readFile(join(home, '.config/joplin-desktop/log.txt'), 'utf8')
      ).matchAll(/Updated FTS table in \d+ms\. Inserted: (\d+)/g)
    ].reduce((n, m) => n + Number(m[1]), 0);
  while ((await indexed()) < expected) await sleep(250);
  results.searchIndexed = Math.round(performance.now() - i0) - results.import;
  log('search index', results.searchIndexed);
  await until(page, inSidebar, basename(copy));
  await sleep(3000);
  results.pssMB.afterImport = pssMB(joplin.proc.pid);

  for (let i = 0; i < Number(values.runs); i++) {
    await joplin.close();
    joplin = await start();
    results.coldStart.push(
      await until(joplin.page, inSidebar, basename(copy), { t0: joplin.t0 })
    );
    log('cold start', results.coldStart.at(-1));
  }
  results.coldStartMedian = median(results.coldStart);
  page = joplin.page;
  await sleep(5000);
  results.pssMB.idle = pssMB(joplin.proc.pid);
  results.heapMB.idle = await page.evaluate(() =>
    Math.round(performance.memory.usedJSHeapSize / 1048576)
  );

  // Search replaces the note list with its hits.
  const items = '.note-list .notes > *';
  const listed = (items) =>
    [...document.querySelectorAll(items)].map((e) => e.textContent).join('|');
  const before = await page.evaluate(listed, items);
  const search = page.getByPlaceholder('Search...');
  const s0 = performance.now();
  await search.fill(query);
  results.searchFirst = await until(
    page,
    ([items, before]) => {
      const now = [...document.querySelectorAll(items)]
        .map((e) => e.textContent)
        .join('|');
      return now.length > 0 && now !== before;
    },
    [items, before],
    { t0: s0 }
  );
  log('search', results.searchFirst);

  // Joplin opens the first hit by itself, so time opening the second.
  const editor = () =>
    [...document.querySelectorAll('.cm-content, .CodeMirror-code')].find((e) =>
      e.checkVisibility()
    )?.textContent ?? '';
  const shown = await page.evaluate(editor);
  const o0 = performance.now();
  await page.locator(items).nth(1).click();
  results.openNote = await until(
    page,
    (shown) => {
      const now =
        [...document.querySelectorAll('.cm-content, .CodeMirror-code')].find(
          (e) => e.checkVisibility()
        )?.textContent ?? '';
      return now.length > 100 && now !== shown;
    },
    shown,
    { t0: o0 }
  );
  log('open note', results.openNote);
  await save(results, values, name);
} finally {
  await joplin.close().catch(() => {});
  await rm(work, { recursive: true, force: true });
}
