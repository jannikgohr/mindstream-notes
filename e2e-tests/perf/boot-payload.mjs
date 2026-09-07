/**
 * What JS the shell actually downloads to show one markdown note, biggest
 * first, with a guess at each chunk's owner from marker strings in its source.
 * The renderer keeps every byte twice over — once as V8's external source
 * string, once as bytecode — so this list is the shortlist for trimming
 * renderer memory.
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const buildDir = join(repoRoot, '.output/build');
const URL_ = process.env.BENCH_URL ?? 'http://localhost:1440/';

const MARKERS = [
  ['katex', /katex/i],
  ['vue', /__v_isRef|createBaseVNode/],
  ['milkdown/prosemirror', /milkdown|ProseMirror|prosemirror/],
  ['codemirror', /@codemirror|cm-content|CodeMirror/],
  ['lezer grammar', /lezer|parser\.configure|ExternalTokenizer/],
  ['dockview', /dv-tabs|dockview/],
  ['yjs', /YText|AbstractType|StructStore/],
  ['mermaid', /mermaid/],
  ['dompurify', /DOMPurify|dompurify/],
  ['lodash', /lodash|defaultsDeep/],
  ['excalidraw', /excalidraw/],
  ['pdf', /pdfjs|PDFDocument/],
  ['svelte', /\$\.template|svelte/]
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(URL_);
await page
  .getByRole('button', { name: 'Welcome', exact: true })
  .first()
  .waitFor();
await page.waitForTimeout(3500);

const loaded = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .filter((e) => e.name.endsWith('.js') || e.name.endsWith('.css'))
    .map((e) => ({
      url: new self.URL(e.name).pathname,
      kb: (e.decodedBodySize || 0) / 1024
    }))
);
await browser.close();

let total = 0;
const rows = [];
for (const r of loaded) {
  total += r.kb;
  let owner = '';
  if (r.url.endsWith('.js')) {
    let src = '';
    try {
      src = readFileSync(join(buildDir, r.url), 'utf8');
    } catch {
      /* served from memory */
    }
    owner = MARKERS.filter(([, re]) => re.test(src))
      .map(([n]) => n)
      .join(' + ');
  }
  rows.push({ ...r, owner });
}

rows.sort((a, b) => b.kb - a.kb);
console.log(
  `boot payload: ${rows.length} files, ${total.toFixed(0)} kB decoded\n`
);
for (const r of rows.slice(0, 25))
  console.log(
    `${r.kb.toFixed(0).padStart(6)} kB  ${r.url.split('/').pop().padEnd(20)} ${r.owner}`
  );
const tail = rows.slice(25).reduce((s, r) => s + r.kb, 0);
console.log(
  `${tail.toFixed(0).padStart(6)} kB  (${rows.length - 25} smaller files)`
);
