import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, allTagsInUse } = vi.hoisted(() => ({
  state: { collectionsById: {} as Record<string, unknown> },
  allTagsInUse: vi.fn(() => [] as string[])
}));

vi.mock('$lib/stores/tree.svelte', () => ({ tree: state, allTagsInUse }));
vi.mock('$lib/api/index', () => ({ TRASH_ID: 'trash' }));
vi.mock('$lib/settings/store.svelte', () => ({
  ALL_SETTINGS: [],
  getSettingValue: vi.fn(),
  setSettingValue: vi.fn()
}));
vi.mock('$lib/plugins/registry.svelte', () => ({
  pluginSettingsSections: () => []
}));

import { folderOptions, tagOptions } from './pickers.svelte';

function folder(id: string, name: string, parent: string | null = null) {
  return { id, name, parent_collection_id: parent };
}

beforeEach(() => {
  state.collectionsById = {};
  allTagsInUse.mockReturnValue([]);
});

describe('folderOptions', () => {
  it('excludes the trash folder and everything under it', () => {
    state.collectionsById = {
      trash: folder('trash', 'Trash'),
      work: folder('work', 'Work'),
      trashed: folder('trashed', 'Old', 'trash')
    };
    expect(folderOptions().map((o) => o.value)).toEqual(['work']);
  });

  it('labels folders with their hierarchical path', () => {
    state.collectionsById = {
      a: folder('a', 'Parent'),
      b: folder('b', 'Child', 'a')
    };
    const child = folderOptions().find((o) => o.value === 'b');
    expect(child?.label).toBe('Parent / Child');
  });
});

describe('tagOptions', () => {
  it('maps tags in use to picker items', () => {
    allTagsInUse.mockReturnValue(['x', 'y']);
    expect(tagOptions()).toEqual([
      { value: 'x', label: 'x' },
      { value: 'y', label: 'y' }
    ]);
  });
});
