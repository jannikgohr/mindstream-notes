import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerPlugin,
  resetPluginRegistry,
  setPluginEnabled
} from '$lib/plugins/registry.svelte';

const loadNoteKindComponent = vi.fn();

// Keep the real kind → loader selection, which reads the plugin registry, but
// never resolve so no editor module is imported.
vi.mock('./note-editor/lazy-components', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./note-editor/lazy-components')>();
  return {
    ...actual,
    loadNoteKindComponent: (kind: string | null | undefined) => {
      actual.noteKindLoader(kind);
      loadNoteKindComponent(kind);
      return new Promise(() => {});
    }
  };
});

import NoteKindRenderer from './NoteKindRenderer.svelte';

const PLUGIN_KIND = 'plugin.com.example.kinds.document';

function kindManifest(version = '1.0.0'): Record<string, unknown> {
  return {
    manifestVersion: 2,
    id: 'com.example.kinds',
    name: 'Kinds',
    version,
    runtime: 'wasm',
    entry: 'plugin.wasm',
    permissions: ['notes.create'],
    contributes: {
      noteKinds: [
        {
          id: 'document',
          labelKey: 'notes.document',
          render: { export: 'renderDocument' }
        }
      ]
    }
  };
}

beforeEach(() => {
  loadNoteKindComponent.mockReset();
});

afterEach(() => {
  cleanup();
  resetPluginRegistry();
});

describe('NoteKindRenderer', () => {
  it('keeps a markdown editor mounted when the plugin registry refreshes', () => {
    registerPlugin(kindManifest());
    render(NoteKindRenderer, { noteId: 'n1', noteKind: 'markdown' });
    expect(loadNoteKindComponent).toHaveBeenCalledTimes(1);

    // A device-settings refresh re-registers every plugin unchanged.
    registerPlugin(kindManifest());
    registerPlugin(kindManifest('1.0.1'));
    setPluginEnabled('com.example.kinds', false);
    flushSync();

    expect(loadNoteKindComponent).toHaveBeenCalledTimes(1);
  });

  it('keeps a plugin editor mounted when its owner re-registers unchanged', () => {
    registerPlugin(kindManifest());
    render(NoteKindRenderer, { noteId: 'n1', noteKind: PLUGIN_KIND });
    expect(loadNoteKindComponent).toHaveBeenCalledTimes(1);

    registerPlugin(kindManifest());
    flushSync();

    expect(loadNoteKindComponent).toHaveBeenCalledTimes(1);
  });

  it('reloads a plugin note when its owner appears, changes or goes away', () => {
    render(NoteKindRenderer, { noteId: 'n1', noteKind: PLUGIN_KIND });
    expect(loadNoteKindComponent).toHaveBeenCalledTimes(1);

    registerPlugin(kindManifest());
    flushSync();
    expect(loadNoteKindComponent).toHaveBeenCalledTimes(2);

    registerPlugin(kindManifest('1.0.1'));
    flushSync();
    expect(loadNoteKindComponent).toHaveBeenCalledTimes(3);

    setPluginEnabled('com.example.kinds', false);
    flushSync();
    expect(loadNoteKindComponent).toHaveBeenCalledTimes(4);
  });
});
