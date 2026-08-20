import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES,
  FILE_TREE_TOOLBAR_STORAGE_KEY,
  LEGACY_FILE_TREE_TOOLBAR_PREFERENCES,
  loadFileTreeToolbarPreferences,
  moveFileTreeToolbarAction,
  normalizeFileTreeToolbarPreferences,
  saveFileTreeToolbarPreferences
} from './file-tree-toolbar-preferences';

const actions = ['note', 'folder', 'drawing', 'ink', 'kanban', 'pdf'];

beforeEach(() => localStorage.clear());

describe('file tree toolbar preferences', () => {
  it('uses the compact default for a new installation', () => {
    expect(loadFileTreeToolbarPreferences(actions)).toEqual(
      DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES
    );
  });

  it('preserves the old toolbar for an existing installation', () => {
    localStorage.setItem('notes-app:preferences:v1', '{}');
    expect(loadFileTreeToolbarPreferences(actions)).toEqual(
      LEGACY_FILE_TREE_TOOLBAR_PREFERENCES
    );
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
});
