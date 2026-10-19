import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES,
  FILE_TREE_ACTION_BUTTON_PX,
  FILE_TREE_ACTION_GAP_PX,
  FILE_TREE_TOOLBAR_MIN_PX,
  FILE_TREE_TOOLBAR_STORAGE_KEY,
  MOBILE_CREATE_TOOLBAR_STORAGE_KEY,
  fileTreeToolbarCapacity,
  LEGACY_FILE_TREE_TOOLBAR_PREFERENCES,
  loadFileTreeToolbarPreferences,
  moveFileTreeToolbarAction,
  normalizeFileTreeToolbarPreferences,
  saveFileTreeToolbarPreferences
} from './file-tree-toolbar-preferences';

const actions = ['note', 'folder', 'drawing', 'ink', 'kanban', 'pdf'];

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('file tree toolbar preferences', () => {
  it('uses the compact default for a new installation', () => {
    expect(loadFileTreeToolbarPreferences(actions)).toEqual(
      DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES
    );
  });

  it('preserves the old toolbar for an existing installation, led by New note', () => {
    localStorage.setItem('notes-app:preferences:v1', '{}');
    expect(loadFileTreeToolbarPreferences(actions)).toEqual({
      toolbar: [
        'note',
        ...LEGACY_FILE_TREE_TOOLBAR_PREFERENCES.toolbar.filter(
          (id) => id !== 'note'
        )
      ],
      more: []
    });
  });

  it('normalizes duplicates and puts newly available actions in More', () => {
    expect(
      normalizeFileTreeToolbarPreferences(
        { toolbar: ['folder', 'folder'], more: ['note', 'missing'] },
        actions
      )
    ).toEqual({
      toolbar: ['folder'],
      more: ['note', 'drawing', 'ink', 'kanban', 'pdf']
    });
  });

  it('always leaves one action in the toolbar', () => {
    expect(
      normalizeFileTreeToolbarPreferences(
        { toolbar: [], more: actions },
        actions
      ).toolbar
    ).toEqual(['note']);
  });

  it('moves actions within and between sections', () => {
    const reordered = moveFileTreeToolbarAction(
      DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES,
      'drawing',
      'toolbar',
      'note'
    );
    // The first action is the main button, so this makes drawings the default.
    expect(reordered.toolbar).toEqual(['drawing', 'note', 'folder']);

    const hidden = moveFileTreeToolbarAction(
      reordered,
      'folder',
      'more',
      'pdf'
    );
    expect(hidden).toEqual({
      toolbar: ['drawing', 'note'],
      more: ['ink', 'folder', 'pdf', 'kanban']
    });
  });

  it('leads an untouched migrated layout with New note but keeps a chosen order', () => {
    localStorage.setItem(
      FILE_TREE_TOOLBAR_STORAGE_KEY,
      JSON.stringify(LEGACY_FILE_TREE_TOOLBAR_PREFERENCES)
    );
    expect(loadFileTreeToolbarPreferences(actions).toolbar[0]).toBe('note');
    // Saved since, a layout lists every other action in More.
    const chosen = {
      toolbar: LEGACY_FILE_TREE_TOOLBAR_PREFERENCES.toolbar,
      more: ['plugin:templates:new']
    };
    localStorage.setItem(FILE_TREE_TOOLBAR_STORAGE_KEY, JSON.stringify(chosen));
    expect(
      loadFileTreeToolbarPreferences([...actions, 'plugin:templates:new'])
    ).toEqual(chosen);
  });

  it('moves the middle item around its neighbour without appending it', () => {
    const preferences = {
      toolbar: ['one', 'two', 'three'],
      more: []
    };

    expect(
      moveFileTreeToolbarAction(preferences, 'two', 'toolbar', 'one').toolbar
    ).toEqual(['two', 'one', 'three']);
    expect(
      moveFileTreeToolbarAction(preferences, 'two', 'toolbar', 'three').toolbar
    ).toEqual(['one', 'two', 'three']);
    expect(
      moveFileTreeToolbarAction(preferences, 'one', 'toolbar').toolbar
    ).toEqual(['two', 'three', 'one']);
  });

  it('round-trips persisted preferences', () => {
    saveFileTreeToolbarPreferences({ toolbar: ['folder'], more: ['note'] });
    expect(localStorage.getItem(FILE_TREE_TOOLBAR_STORAGE_KEY)).not.toBeNull();
    expect(loadFileTreeToolbarPreferences(['folder', 'note'])).toEqual({
      toolbar: ['folder'],
      more: ['note']
    });
  });

  it('keeps plugin IDs and mobile edits separate from the desktop layout', () => {
    const plugin = 'plugin:com.example.templates:create';
    const available = [...actions, plugin];
    const desktop = {
      toolbar: ['note', plugin, 'folder'],
      more: ['drawing', 'ink', 'kanban', 'pdf']
    };
    saveFileTreeToolbarPreferences(desktop);
    const initialMobile = loadFileTreeToolbarPreferences(available, 'mobile');
    expect(initialMobile).toEqual(desktop);
    const mobile = normalizeFileTreeToolbarPreferences(
      moveFileTreeToolbarAction(initialMobile, plugin, 'toolbar', 'note'),
      available
    );
    saveFileTreeToolbarPreferences(mobile, 'mobile');
    expect(loadFileTreeToolbarPreferences(available, 'mobile')).toEqual(mobile);
    expect(loadFileTreeToolbarPreferences(available)).toEqual(desktop);
    expect(
      localStorage.getItem(MOBILE_CREATE_TOOLBAR_STORAGE_KEY)
    ).not.toBeNull();
    saveFileTreeToolbarPreferences({ toolbar: ['folder'], more: ['note'] });
    expect(loadFileTreeToolbarPreferences(available, 'mobile')).toEqual(mobile);
  });

  it('writes each native layout to its own device field', async () => {
    const { applyNativeDeviceUi, registerNativeDeviceUiWriter } =
      await import('$lib/native-device-ui.svelte');
    const desktop = { toolbar: ['note'], more: ['folder'] };
    const mobile = {
      toolbar: ['plugin:com.example.templates:create'],
      more: ['note', 'folder']
    };
    const writer = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    applyNativeDeviceUi({
      'ui.fileTreeToolbar': desktop,
      'ui.mobileCreateToolbar': mobile
    });
    registerNativeDeviceUiWriter(writer);
    expect(loadFileTreeToolbarPreferences(['note', 'folder'])).toEqual(desktop);
    expect(
      loadFileTreeToolbarPreferences(
        [...mobile.toolbar, 'note', 'folder'],
        'mobile'
      )
    ).toEqual(mobile);
    await saveFileTreeToolbarPreferences(mobile, 'mobile');
    expect(writer).toHaveBeenCalledWith('ui.mobileCreateToolbar', mobile);
    await saveFileTreeToolbarPreferences(desktop);
    expect(writer).toHaveBeenLastCalledWith('ui.fileTreeToolbar', desktop);
  });

  it('uses defaults when storage is unavailable or contains invalid JSON', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadFileTreeToolbarPreferences(actions)).toEqual(
      DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES
    );

    vi.unstubAllGlobals();
    localStorage.setItem(FILE_TREE_TOOLBAR_STORAGE_KEY, '{invalid');
    expect(loadFileTreeToolbarPreferences(actions)).toEqual(
      DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES
    );
  });

  it('ignores storage write failures', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('localStorage', {
      setItem: vi.fn(() => {
        throw new Error('storage disabled');
      })
    });

    expect(() =>
      saveFileTreeToolbarPreferences({ toolbar: ['note'], more: [] })
    ).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      '[file-tree-toolbar] save failed',
      expect.any(Error)
    );
  });
});

describe('file tree toolbar capacity', () => {
  const slot = FILE_TREE_ACTION_BUTTON_PX + FILE_TREE_ACTION_GAP_PX;

  it('fits as many actions as the row has room for beside the ⋯ trigger', () => {
    expect(fileTreeToolbarCapacity(FILE_TREE_ACTION_BUTTON_PX + slot)).toBe(1);
    expect(fileTreeToolbarCapacity(FILE_TREE_ACTION_BUTTON_PX + slot * 3)).toBe(
      3
    );
  });

  it('keeps one action at the documented minimum width', () => {
    expect(fileTreeToolbarCapacity(FILE_TREE_TOOLBAR_MIN_PX)).toBe(1);
  });

  it('overflows everything rather than clipping a button that does not fit', () => {
    // Regression: the old maths floored at 1, so a squeezed row rendered an
    // action with no room for it. `justify-end` + `overflow-hidden` clipped
    // that button out of view while the capacity maths still counted it as
    // shown, so it appeared in neither the row nor the ⋯ menu.
    expect(fileTreeToolbarCapacity(FILE_TREE_TOOLBAR_MIN_PX - 1)).toBe(0);
    expect(fileTreeToolbarCapacity(FILE_TREE_ACTION_BUTTON_PX)).toBe(0);
    expect(fileTreeToolbarCapacity(0)).toBe(0);
  });

  it('survives a row it was never measured against', () => {
    expect(fileTreeToolbarCapacity(-10)).toBe(0);
    expect(fileTreeToolbarCapacity(Number.NaN)).toBe(0);
    expect(fileTreeToolbarCapacity(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
