import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  setSettingValue: vi.fn()
}));

vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) => h.values[id],
  setSettingValue: (id: string, value: unknown) => {
    h.values[id] = value;
    return h.setSettingValue(id, value);
  }
}));

import {
  EXPANDED_FOLDERS_SETTING,
  MAX_EXPANDED_FOLDERS,
  expandedFoldersToSave,
  loadExpandedFolders,
  saveExpandedFolders
} from './file-tree-expansion';

beforeEach(() => {
  h.values = {};
  h.setSettingValue.mockReset().mockResolvedValue(undefined);
});

describe('file tree expansion', () => {
  it('reads nothing when nothing was saved', () => {
    expect(loadExpandedFolders()).toEqual([]);
  });

  it('reads the saved ids and ignores anything else', () => {
    h.values[EXPANDED_FOLDERS_SETTING] = ['coll_a', '', 3, null, 'coll_b'];
    expect(loadExpandedFolders()).toEqual(['coll_a', 'coll_b']);
    h.values[EXPANDED_FOLDERS_SETTING] = { coll_a: true };
    expect(loadExpandedFolders()).toEqual([]);
  });

  it('saves the open folders that still exist, in a stable order', () => {
    const folders = new Set(['coll_a', 'coll_b', 'coll_c']);
    expect(
      expandedFoldersToSave(
        { coll_c: true, coll_a: true, coll_b: false, coll_gone: true },
        (id) => folders.has(id)
      )
    ).toEqual(['coll_a', 'coll_c']);
  });

  it('bounds what one save writes', () => {
    const expanded = Object.fromEntries(
      Array.from({ length: MAX_EXPANDED_FOLDERS + 10 }, (_, i) => [
        `coll_${String(i).padStart(5, '0')}`,
        true
      ])
    );
    expect(expandedFoldersToSave(expanded, () => true)).toHaveLength(
      MAX_EXPANDED_FOLDERS
    );
  });

  it('saves through the settings store, which keeps it per vault', async () => {
    await saveExpandedFolders(['coll_a']);
    expect(h.setSettingValue).toHaveBeenCalledWith(EXPANDED_FOLDERS_SETTING, [
      'coll_a'
    ]);
    expect(loadExpandedFolders()).toEqual(['coll_a']);
  });
});
