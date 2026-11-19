import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the shipped `plugins/*/plugin.wasm` through the browser host. The tree,
// the settings and the Worker are stand-ins; everything from the context merge
// down is real.
const { tree, settings } = vi.hoisted(() => ({
  tree: {
    notesById: {} as Record<string, unknown>,
    collectionsById: {} as Record<string, unknown>
  },
  settings: {} as Record<string, unknown>
}));
vi.mock('$lib/stores/tree.svelte', () => ({ tree }));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) => settings[id]
}));

import {
  bundledWasmManifests,
  handlePluginRequest,
  type PluginRequest,
  type PluginResponse
} from './browser-runtime';
import { resetPluginRunner } from './plugin-runner';
import {
  registerPlugin,
  resetPluginRegistry,
  setPluginEnabled
} from './registry.svelte';
import { runPluginScript } from './run-script';

const TEMPLATES = 'com.mindstream.templates.core';
const TYPST = 'com.mindstream.typst';

function note(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    tags: [],
    trashed: false,
    note_kind: 'markdown',
    parent_collection_id: null,
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-02T00:00:00Z',
    ...extra
  };
}

const posted: PluginResponse[] = [];

/** Runs the Worker's handler in-process, behind the clone a real one applies. */
class InlineWorker {
  onmessage: ((event: { data: PluginResponse }) => void) | null = null;
  postMessage(request: PluginRequest) {
    void handlePluginRequest(structuredClone(request), (data) => {
      posted.push(data);
      this.onmessage?.({ data: structuredClone(data) });
    });
  }
  terminate() {}
}

beforeEach(() => {
  vi.stubGlobal('Worker', InlineWorker);
  for (const manifest of bundledWasmManifests()) registerPlugin(manifest);
  tree.collectionsById = {
    root: { id: 'root', name: 'Templates', parent_collection_id: null },
    child: { id: 'child', name: 'Daily', parent_collection_id: 'root' }
  };
  tree.notesById = {
    z: note('z', 'Zulu', { parent_collection_id: 'child' }),
    a: note('a', 'Alpha', { tags: ['template'] }),
    t: note('t', 'Trashed', { tags: ['template'], trashed: true }),
    o: note('o', 'Other')
  };
});
afterEach(() => {
  posted.length = 0;
  resetPluginRunner();
  vi.unstubAllGlobals();
  resetPluginRegistry();
  for (const key of Object.keys(settings)) delete settings[key];
});

it('runs every bundled Wasm plugin', () => {
  expect(bundledWasmManifests().map((m) => (m as { id: string }).id)).toEqual([
    TEMPLATES,
    TYPST
  ]);
});

it("starts a call's deadline only after the call before it is done", async () => {
  await Promise.all([
    runPluginScript(TYPST, 'exportDocument', { format: 'typ', body: 'a' }),
    runPluginScript(TYPST, 'exportDocument', { format: 'typ', body: 'b' })
  ]);
  expect(posted.map((message) => Object.keys(message)[1])).toEqual([
    'started',
    'output',
    'started',
    'output'
  ]);
});

describe('Templates', () => {
  it('lists template notes from the folder tree and the tag', async () => {
    settings[`plugins.${TEMPLATES}.source-folder`] = 'root';
    settings[`plugins.${TEMPLATES}.source-tag`] = 'template';
    expect(await runPluginScript(TEMPLATES, 'newFromTemplate', {})).toEqual({
      effect: 'openMenu',
      items: [
        {
          label: 'Alpha',
          run: { effect: 'createNoteFromNote', sourceNoteId: 'a' }
        },
        {
          label: 'Zulu',
          run: { effect: 'createNoteFromNote', sourceNoteId: 'z' }
        }
      ]
    });
  });

  it('renders dates through the host clock in local time', async () => {
    vi.useFakeTimers({ now: new Date(2026, 0, 31, 12), toFake: ['Date'] });
    try {
      expect(
        await runPluginScript(TEMPLATES, 'renderTemplate', {
          locale: 'de',
          title: 'Log {{date:YYYY}}',
          body: '{{title|upper}} {{date+1M}} {{date-1y+2w:dddd}} {{word|slug}}',
          vars: { word: ' hÄllo WORLD ' }
        })
      ).toEqual({
        title: 'Log 2026',
        body: 'LOG 2026 2026-02-28 Freitag h-llo-world'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a plugin error as the call failure', async () => {
    await expect(runPluginScript(TEMPLATES, 'nope', {})).rejects.toThrow(
      'unknown export nope'
    );
  });

  it('refuses a disabled plugin', async () => {
    setPluginEnabled(TEMPLATES, false);
    await expect(
      runPluginScript(TEMPLATES, 'newFromTemplate', {})
    ).rejects.toThrow(`plugin ${TEMPLATES} is not enabled`);
  });
});

describe('Typst', () => {
  it('falls back to source only without the typst binary', async () => {
    expect(
      await runPluginScript(TYPST, 'renderDocument', { body: '= Hi' })
    ).toEqual({ sourceOnly: true, diagnostics: [] });
  });

  it('exports its source', async () => {
    expect(
      await runPluginScript(TYPST, 'exportDocument', {
        format: 'typ',
        body: '= Hi'
      })
    ).toEqual({ file: { mime: 'text/plain', text: '= Hi' } });
  });
});
