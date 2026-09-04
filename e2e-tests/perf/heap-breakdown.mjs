/**
 * Where the renderer's JS heap goes: takes a V8 heap snapshot over CDP with the
 * app booted and one markdown note open, then aggregates self-size by
 * constructor so the biggest owners are obvious.
 */
import { chromium } from '@playwright/test';

const URL = process.env.BENCH_URL ?? 'http://localhost:1440/';
const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
const page = await browser.newPage();
await page.goto(URL);
await page
  .getByRole('button', { name: 'Welcome', exact: true })
  .first()
  .waitFor();
await page.waitForTimeout(3000);

const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.collectGarbage');

const chunks = [];
cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => chunks.push(chunk));
await cdp.send('HeapProfiler.takeHeapSnapshot', {
  reportProgress: false,
  treatGlobalObjectsAsRoots: true
});
const snap = JSON.parse(chunks.join(''));

const nodeFields = snap.snapshot.meta.node_fields;
const nodeTypes = snap.snapshot.meta.node_types[0];
const F = nodeFields.length;
const iType = nodeFields.indexOf('type');
const iName = nodeFields.indexOf('name');
const iSize = nodeFields.indexOf('self_size');

const byName = new Map();
const byType = new Map();
let total = 0;
for (let o = 0; o < snap.nodes.length; o += F) {
  const size = snap.nodes[o + iSize];
  const type = nodeTypes[snap.nodes[o + iType]];
  const name = snap.strings[snap.nodes[o + iName]] || '(anonymous)';
  total += size;
  byType.set(type, (byType.get(type) ?? 0) + size);
  const key = `${type}:${name}`;
  byName.set(key, (byName.get(key) ?? 0) + size);
}

const mb = (n) => (n / 1048576).toFixed(2).padStart(7);
console.log(`total heap in snapshot: ${mb(total)} MB\n`);
console.log('by node type:');
for (const [t, s] of [...byType].sort((a, b) => b[1] - a[1]))
  console.log(`  ${mb(s)} MB  ${t}`);
console.log('\ntop 30 by constructor / name:');
for (const [k, s] of [...byName].sort((a, b) => b[1] - a[1]).slice(0, 30))
  console.log(`  ${mb(s)} MB  ${k.slice(0, 90)}`);

await browser.close();
