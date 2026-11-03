// @vitest-environment node
/**
 * The browser port against the shipped Templates component.
 *
 * The app runs `plugins/templates/plugin.wasm`; the browser runs the port in
 * `browser-templates.ts`. This runs the real component through the SDK's
 * jco-based loader, whose mock host keeps the app host's local-time rules, on
 * the inputs of `rust_templates_prototype_matches_typescript_outputs`
 * (`src-tauri/plugin-runtime/src/wasm/tests.rs`), and expects the port to
 * answer the same.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPlugin } from '../../../plugin-sdk/typescript/lib/testing.js';
import type { HostOptions } from '../../../plugin-sdk/typescript/lib/testing';
import { invokeTemplatesPlugin } from './browser-templates';

const component = join(
  import.meta.dirname,
  '../../../plugins/templates/plugin.wasm'
);
const defaultNow = '2026-07-25T10:00:00Z';

const notes = Array.from({ length: 50 }, (_, i) => ({
  id: `n${i}`,
  title: ['Zulu', 'Alpha', '😀', '\u{e000}', 'Alpha'][i % 5],
  tags: i % 3 === 0 ? ['template'] : [],
  folderId: i % 2 === 0 ? 'child' : 'cycle'
}));

type Input = Record<string, unknown>;

/** Both answers for one call. The loader merges `settings`/`folders`/`now` like the app. */
async function both(exportName: string, input: Input) {
  const options: HostOptions = {
    now: (input.now as string | undefined) ?? defaultNow,
    permissions: ['notes.read'],
    notes,
    settings: (input.settings as Record<string, unknown>) ?? {},
    folders: (input.folders as HostOptions['folders']) ?? []
  };
  const plugin = await loadPlugin(component, options);
  const shipped = await plugin.call(exportName, input);
  const port = invokeTemplatesPlugin(
    exportName,
    {
      activeNoteId: null,
      locale: 'en',
      ...input,
      settings: options.settings,
      folders: options.folders,
      now: new Date(options.now!).toISOString()
    },
    {
      notes: () => notes,
      uuid: () => 'uuid'
    }
  );
  return { shipped, port };
}

const renderInputs: Input[] = [
  {
    now: '2026-07-25T10:00:00Z',
    locale: 'de',
    title: 'Log {{date:YYYY}}',
    body: '{{title|upper}} {{date-1M+2d:YYYY-MM-DD}} {{date+7d:dddd}}'
  },
  {
    now: '2026-01-31T12:00:00Z',
    body: '{{date+1M:YYYY-MM-DD}} {{date-1y+2w:YYYY-MM-DD}} {{word|trim|capitalize}}/{{word|slug}}/{{flag}}/{{number}}/{{missing}}/{{word|unknown}}',
    vars: { word: '  hÄllo WORLD  ', flag: false, number: 42 }
  },
  {
    now: '2026-07-25T10:00:00Z',
    title: '{{unknown}}',
    body: '{{date:}} {{multi\nline}} {{literal',
    vars: { 'multi\nline': 'yes' }
  },
  {
    body: '{{word|capitalize}}/{{word|upper}}/{{arr}}/{{obj}}/{{float}}',
    vars: {
      word: '😀café',
      arr: [1, null, true, ['a', 'b']],
      obj: {},
      float: 1.0
    }
  },
  {
    now: '2028-01-31T00:30:00Z',
    body: '{{date+1M:YYYY-MM-DD HH:mm:ss}}/{{date-1y:dddd}}'
  },
  {
    now: '2026-03-28T11:00:00Z',
    body: '{{date+1d:YYYY-MM-DD HH:mm}}/{{date+1M:YYYY-MM-DD HH:mm}}'
  },
  // Rust's `2026-01-29T01:30:00Z` +2M case is left out: in zones where it lands
  // in a DST gap, the app host keeps the original time while the SDK's mock
  // host rolls forward. `browser-templates.test.ts` pins the app's answer.
  { now: '2026-08-25T00:30:00Z', body: '{{date+2M:YYYY-MM-DD HH:mm}}' },
  {
    now: '2026-07-25T10:00:00Z',
    title: '{{date:YYYY}}',
    body: '{{date+1M-2d:YYYY-MM-DD}} '.repeat(50)
  },
  // A variable named like a built-in, and spacing inside placeholders.
  {
    now: '2026-12-31T23:30:00Z',
    title: '{{ date : dddd }}',
    body: '{{ title | lower }} {{date}} {{ time }} {{datetime+1h}}',
    vars: { date: 'overridden' }
  }
];

const menuInputs: Input[] = [
  {},
  { settings: { 'source-tag': 'missing' } },
  {
    settings: { 'source-folder': 'root', 'source-tag': 'template' },
    folders: [
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
      { id: 'cycle', parentId: 'cycle' }
    ]
  }
];

// Each case transpiles and instantiates the real component.
describe(
  'the browser Templates port answers like plugin.wasm',
  { timeout: 60_000 },
  () => {
    it.each(renderInputs)('renderTemplate %#', async (input) => {
      const { shipped, port } = await both('renderTemplate', input);
      expect(port).toEqual(shipped);
    });

    it.each(menuInputs)('newFromTemplate %#', async (input) => {
      const { shipped, port } = await both('newFromTemplate', input);
      expect(port).toEqual(shipped);
    });

    it('lists the same exports', async () => {
      const { shipped, port } = await both('$exports', {});
      expect(port).toEqual(shipped);
    });
  }
);
