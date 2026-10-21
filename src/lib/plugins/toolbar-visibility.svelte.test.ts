import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import manifest from '../../../plugins/templates/manifest.json';
import { TRASH_ID, type Collection, type NoteSummary } from '$lib/api';
import { tree } from '$lib/stores/tree.svelte';
import {
  registerPlugin,
  resetPluginRegistry,
  setPluginEnabled,
  unregisterPlugin
} from './registry.svelte';
import {
  pluginSettingId,
  resetPluginSettingsCache,
  setPluginSettingValue
} from './settings-store.svelte';
import { visiblePluginToolbarButtons } from './toolbar-visibility.svelte';
import { validateManifest } from './validation';

const id = manifest.id;
const visible = () => visiblePluginToolbarButtons('file-tree').length;
const set = (key: string, value: unknown) =>
  setPluginSettingValue(pluginSettingId(id, key), value);
function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'n',
    title: 'Template',
    parent_collection_id: null,
    position: 0,
    created: '',
    modified: '',
    tags: [],
    trashed: false,
    favourite: false,
    pushed: false,
    note_kind: 'markdown',
    ...overrides
  };
}
function folder(id: string, parent: string | null = null): Collection {
  return {
    id,
    parent_collection_id: parent,
    name: id,
    position: 0,
    created: '',
    modified: ''
  };
}

beforeEach(() => {
  resetPluginRegistry();
  resetPluginSettingsCache();
  registerPlugin(manifest);
  tree.notesById = {};
  tree.collectionsById = {};
  tree.ready = true;
  tree.error = null;
});
afterEach(() => {
  resetPluginRegistry();
  resetPluginSettingsCache();
  tree.notesById = {};
  tree.collectionsById = {};
  tree.ready = false;
  tree.error = null;
});

describe('template toolbar availability', () => {
  it('hides unconfigured and configured-but-empty sources', async () => {
    tree.notesById.n = note({ tags: ['unrelated'] });
    expect(visible()).toBe(0);
    await set('source-tag', 'template');
    expect(visible()).toBe(0);
    await set('source-folder', 'templates');
    expect(visible()).toBe(0);
  });

  it('matches either source, including folder descendants and every note kind', async () => {
    await set('source-tag', 'template');
    await set('source-folder', 'templates');
    tree.collectionsById = {
      templates: folder('templates'),
      child: folder('child', 'templates')
    };
    tree.notesById.n = note({
      parent_collection_id: 'child',
      note_kind: 'plugin.com.mindstream.typst.document'
    });
    expect(visible()).toBe(1);
    tree.notesById.n.parent_collection_id = 'templates';
    expect(visible()).toBe(1);
    tree.notesById.n.parent_collection_id = null;
    expect(visible()).toBe(0);
    tree.notesById.n.tags = ['template'];
    expect(visible()).toBe(1);
    tree.notesById.n.tags = ['Template'];
    expect(visible()).toBe(0);
  });

  it('excludes trashed notes and notes under trashed folders, with cycle-safe ancestry', async () => {
    await set('source-tag', 'template');
    tree.notesById.n = note({ tags: ['template'], trashed: true });
    expect(visible()).toBe(0);
    tree.notesById.n.trashed = false;
    tree.notesById.n.parent_collection_id = 'child';
    tree.collectionsById = { child: folder('child', TRASH_ID) };
    expect(visible()).toBe(0);
    tree.collectionsById.child.parent_collection_id = 'cycle';
    tree.collectionsById.cycle = folder('cycle', 'child');
    await set('source-tag', '');
    await set('source-folder', 'templates');
    expect(visible()).toBe(0);
    await set('source-folder', 'cycle');
    expect(visible()).toBe(1);
  });

  it('hides until metadata is available and when permission or plugin is removed', async () => {
    await set('source-tag', 'template');
    tree.notesById.n = note({ tags: ['template'] });
    tree.ready = false;
    expect(visible()).toBe(0);
    tree.ready = true;
    tree.error = 'vault unavailable';
    expect(visible()).toBe(0);
    tree.error = null;
    expect(visible()).toBe(1);
    registerPlugin(manifest, { granted: ['notes.create'] });
    expect(visible()).toBe(0);
    registerPlugin(manifest);
    setPluginEnabled(id, false);
    expect(visible()).toBe(0);
    setPluginEnabled(id, true);
    expect(visible()).toBe(1);
    unregisterPlugin(id);
    expect(visible()).toBe(0);
  });

  it('uses setting defaults and preserves explicit empty values', async () => {
    const copy = validateManifest(structuredClone(manifest));
    const tag = copy.contributes.settings?.[0].settings[1];
    if (!tag) throw new Error('Template tag setting missing');
    tag.default = 'template';
    registerPlugin(copy);
    tree.notesById.n = note({ tags: ['template'] });
    expect(visible()).toBe(1);
    await set('source-tag', '');
    expect(visible()).toBe(0);
  });

  it('reacts to setting, note, folder move and removal changes without guest calls', async () => {
    const counts: number[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        counts.push(visible());
      });
    });
    try {
      flushSync();
      expect(counts.at(-1)).toBe(0);
      tree.collectionsById = {
        templates: folder('templates'),
        child: folder('child')
      };
      tree.notesById.n = note({ parent_collection_id: 'child' });
      await set('source-folder', 'templates');
      flushSync();
      expect(counts.at(-1)).toBe(0);
      tree.collectionsById.child.parent_collection_id = 'templates';
      flushSync();
      expect(counts.at(-1)).toBe(1);
      delete tree.notesById.n;
      flushSync();
      expect(counts.at(-1)).toBe(0);
      tree.notesById.n = note({ tags: ['template'] });
      await set('source-tag', 'template');
      flushSync();
      expect(counts.at(-1)).toBe(1);
      tree.notesById.n.tags = [];
      flushSync();
      expect(counts.at(-1)).toBe(0);
    } finally {
      stop();
    }
  });
});
