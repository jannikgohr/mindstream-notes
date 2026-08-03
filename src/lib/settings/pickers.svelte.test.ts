import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

const {
  tree,
  allTagsInUse,
  ALL_SETTINGS,
  getSettingValue,
  setSettingValue,
  pluginSettingsSections
} = vi.hoisted(() => ({
  tree: {
    ready: true,
    collectionsById: {} as Record<
      string,
      { name: string; parent_collection_id: string | null }
    >
  },
  allTagsInUse: vi.fn(() => [] as string[]),
  ALL_SETTINGS: [] as unknown[],
  getSettingValue: vi.fn(),
  setSettingValue: vi.fn(() => Promise.resolve()),
  pluginSettingsSections: vi.fn(() => [] as unknown[])
}));

vi.mock('$lib/stores/tree.svelte', () => ({ tree, allTagsInUse }));
vi.mock('$lib/api/index', () => ({ TRASH_ID: 'trash' }));
vi.mock('./store.svelte', () => ({
  ALL_SETTINGS,
  getSettingValue,
  setSettingValue
}));
vi.mock('$lib/plugins/registry.svelte', () => ({ pluginSettingsSections }));

import {
  folderOptions,
  startPickerSettingPruning,
  tagOptions
} from './pickers.svelte';

beforeEach(() => {
  tree.ready = true;
  tree.collectionsById = {
    root: { name: 'Root', parent_collection_id: null },
    child: { name: 'Child', parent_collection_id: 'root' },
    trash: { name: 'Trash', parent_collection_id: null },
    gone: { name: 'Gone', parent_collection_id: 'trash' }
  };
  allTagsInUse.mockReturnValue(['alpha', 'beta']);
  ALL_SETTINGS.length = 0;
  getSettingValue.mockReset();
  setSettingValue.mockReset().mockResolvedValue(undefined);
  pluginSettingsSections.mockReset().mockReturnValue([]);
});

describe('folderOptions', () => {
  it('lists live folders with hierarchical labels, excluding trashed ones', () => {
    const options = folderOptions();
    const labels = options.map((o) => o.label);
    expect(labels).toContain('Root');
    expect(labels).toContain('Root / Child');
    // Trash and its descendants are excluded.
    expect(options.some((o) => o.value === 'trash')).toBe(false);
    expect(options.some((o) => o.value === 'gone')).toBe(false);
    // Sorted by path.
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });
});

describe('tagOptions', () => {
  it('maps tags-in-use to picker items', () => {
    expect(tagOptions()).toEqual([
      { value: 'alpha', label: 'alpha' },
      { value: 'beta', label: 'beta' }
    ]);
  });
});

describe('startPickerSettingPruning', () => {
  it('clears a folder setting whose target was trashed/deleted', () => {
    ALL_SETTINGS.push({ id: 'default-folder', type: 'folder' });
    getSettingValue.mockReturnValue('gone'); // under trash → orphaned
    const stop = startPickerSettingPruning();
    flushSync();
    expect(setSettingValue).toHaveBeenCalledWith('default-folder', '');
    stop();
  });

  it('clears an orphaned plugin tag setting but keeps a live one', () => {
    pluginSettingsSections.mockReturnValue([
      {
        pluginId: 'com.x',
        contribution: {
          settings: [
            { id: 'source-tag', type: 'tag' },
            { id: 'live-tag', type: 'tag' }
          ]
        }
      }
    ]);
    getSettingValue.mockImplementation((id: string) =>
      id === 'plugins.com.x.source-tag' ? 'missing-tag' : 'alpha'
    );
    const stop = startPickerSettingPruning();
    flushSync();
    expect(setSettingValue).toHaveBeenCalledWith(
      'plugins.com.x.source-tag',
      ''
    );
    expect(setSettingValue).not.toHaveBeenCalledWith(
      'plugins.com.x.live-tag',
      ''
    );
    stop();
  });

  it('does nothing before the tree is ready', () => {
    tree.ready = false;
    ALL_SETTINGS.push({ id: 'default-folder', type: 'folder' });
    getSettingValue.mockReturnValue('gone');
    const stop = startPickerSettingPruning();
    flushSync();
    expect(setSettingValue).not.toHaveBeenCalled();
    stop();
  });
});
