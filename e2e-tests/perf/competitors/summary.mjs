/**
 * Prints a Markdown table of every result in .output/bench/competitors/,
 * one column per file.
 *
 *   node e2e-tests/perf/competitors/summary.mjs [DIR]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './common.mjs';

const dir = process.argv[2] ?? join(root, '.output', 'bench', 'competitors');
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
const runs = await Promise.all(
  files.map(async (f) => ({
    name: f.slice(0, -5),
    ...JSON.parse(await readFile(join(dir, f), 'utf8'))
  }))
);

const time = (ms) =>
  ms == null
    ? '—'
    : ms >= 10_000
      ? `${Math.round(ms / 1000)} s`
      : ms >= 1000
        ? `${(ms / 1000).toFixed(2)} s`
        : `${ms} ms`;
const fps = (f) => (f ? `${f.fps} fps, p95 ${f.p95} ms, max ${f.max}` : '—');
const mb = (v) => (v == null ? '—' : `${v} MB`);
const rows = [
  [
    'Import / first index',
    (r) => (r.importFailed ? 'failed' : time(r.import ?? r.firstIndex))
  ],
  ['Search index ready after import', (r) => time(r.searchIndexed)],
  ['Cold start (median)', (r) => time(r.coldStartMedian)],
  ['Index clean after start', (r) => time(r.coldIndexedMedian)],
  ['Search, first hit', (r) => time(r.searchFirst)],
  ['Search, done', (r) => time(r.searchDone)],
  ['Open note', (r) => time(r.openNote)],
  ['Local graph', (r) => time(r.localGraph)],
  [
    'Graph nodes / links',
    (r) => (r.graphNodes == null ? '—' : `${r.graphNodes} / ${r.graphLinks}`)
  ],
  ['Graph first draw', (r) => time(r.graphTab)],
  [
    'Graph settled',
    (r) =>
      r.graphSettled === null ? 'not within --settle' : time(r.graphSettled)
  ],
  ['Frames, first 5 s', (r) => fps(r.graphFrames)],
  ['Zoom, early', (r) => fps(r.graphZoomFrames)],
  ['Frames, late', (r) => fps(r.graphLateFrames)],
  ['Zoom, late', (r) => fps(r.graphLateZoomFrames)],
  ['PSS idle', (r) => mb(r.pssMB?.idle)],
  ['PSS with graph, late', (r) => mb(r.pssMB?.graphLate)]
];

console.log(`| | ${runs.map((r) => r.name).join(' | ')} |`);
console.log(`| --- |${runs.map(() => ' ---: |').join('')}`);
for (const [label, cell] of rows)
  console.log(`| ${label} | ${runs.map(cell).join(' | ')} |`);
