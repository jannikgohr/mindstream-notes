import { beforeEach, describe, expect, it, vi } from 'vitest';

// `$app/navigation` is a SvelteKit virtual module; the tree/app-state
// stores drag in heavy deps. Mock all three so the mobile state logic is
// exercised in isolation. vi.hoisted keeps the spies available to the
// hoisted vi.mock factories.
const { pushState, setActiveNote, setNoteFavourite, tree } = vi.hoisted(() => ({
  pushState: vi.fn(),
  setActiveNote: vi.fn(),
  setNoteFavourite: vi.fn().mockResolvedValue(undefined),
  tree: { notesById: {} as Record<string, { favourite: boolean }> }
}));
vi.mock('$app/navigation', () => ({ pushState }));
vi.mock('$lib/state.svelte', () => ({ setActiveNote }));
vi.mock('$lib/stores/tree.svelte', () => ({ tree, setNoteFavourite }));

import {
  collapseFab,
  clearMobileBatchSelection,
  installMobileHistoryNav,
  isFavourite,
  isMobileBatchSelected,
  migrateLegacyFavourites,
  mobileBatchSelection,
  mobileBatchKey,
  mobileState,
  navigateBack,
  navigateToEditor,
  setCurrentFolder,
  setMobileBatchSelection,
  setDisplayMode,
  setMobileScreen,
  setMobileView,
  toggleFabExpanded,
  toggleMobileBatchItem,
  toggleFavourite
} from './state.svelte';

beforeEach(() => {
  pushState.mockClear();
  setActiveNote.mockClear();
  setNoteFavourite.mockClear();
  tree.notesById = {};
  localStorage.clear();
  mobileState.screen = 'home';
  mobileState.view = 'home';
  mobileState.currentFolderId = null;
  mobileState.fabExpanded = false;
  clearMobileBatchSelection();
});

describe('screen + fab', () => {
  it('setMobileScreen switches the screen and collapses the fab on home', () => {
    mobileState.fabExpanded = true;
    setMobileScreen('editor');
    expect(mobileState.screen).toBe('editor');
    expect(mobileState.fabExpanded).toBe(true);

    setMobileScreen('home');
    expect(mobileState.fabExpanded).toBe(false);
  });

  it('toggleFabExpanded flips and collapseFab forces closed', () => {
    toggleFabExpanded();
    expect(mobileState.fabExpanded).toBe(true);
    collapseFab();
    expect(mobileState.fabExpanded).toBe(false);
  });
});

describe('view + folder', () => {
  it('setMobileView resets the drilled folder when switching buckets', () => {
    mobileState.currentFolderId = 'folder-1';
    setMobileBatchSelection([{ kind: 'note', id: 'n1' }]);
    setMobileView('favourite');
    expect(mobileState.view).toBe('favourite');
    expect(mobileState.currentFolderId).toBeNull();
    expect(mobileBatchSelection.items).toEqual([]);
  });

  it('setMobileView keeps the folder when the view is unchanged', () => {
    setCurrentFolder('folder-1');
    setMobileBatchSelection([{ kind: 'note', id: 'n1' }]);
    mobileState.view = 'home';
    setMobileView('home');
    expect(mobileState.currentFolderId).toBe('folder-1');
    expect(mobileBatchSelection.items).toEqual([{ kind: 'note', id: 'n1' }]);
  });

  it('setCurrentFolder updates the drill-down target', () => {
    setMobileBatchSelection([{ kind: 'folder', id: 'f1' }]);
    setCurrentFolder('abc');
    expect(mobileState.currentFolderId).toBe('abc');
    expect(mobileBatchSelection.items).toEqual([]);
    setCurrentFolder(null);
    expect(mobileState.currentFolderId).toBeNull();
  });
});

describe('batch selection', () => {
  it('keys, de-dupes, toggles and clears selected items', () => {
    expect(mobileBatchKey({ kind: 'note', id: 'n1' })).toBe('note:n1');
    setMobileBatchSelection([
      { kind: 'note', id: 'n1' },
      { kind: 'note', id: 'n1' },
      { kind: 'folder', id: 'f1' }
    ]);
    expect(mobileBatchSelection.items).toEqual([
      { kind: 'note', id: 'n1' },
      { kind: 'folder', id: 'f1' }
    ]);
    expect(isMobileBatchSelected({ kind: 'note', id: 'n1' })).toBe(true);

    toggleMobileBatchItem({ kind: 'note', id: 'n1' });
    expect(mobileBatchSelection.items).toEqual([{ kind: 'folder', id: 'f1' }]);

    toggleMobileBatchItem({ kind: 'note', id: 'n2' });
    expect(mobileBatchSelection.items).toEqual([
      { kind: 'folder', id: 'f1' },
      { kind: 'note', id: 'n2' }
    ]);

    clearMobileBatchSelection();
    expect(mobileBatchSelection.items).toEqual([]);
  });

  it('opening the editor clears batch selection', () => {
    setMobileBatchSelection([{ kind: 'note', id: 'n1' }]);
    navigateToEditor('n1');
    expect(mobileBatchSelection.items).toEqual([]);
  });
});

describe('display mode', () => {
  it('persists the chosen mode to localStorage', () => {
    setDisplayMode('grid');
    expect(mobileState.displayMode).toBe('grid');
    expect(localStorage.getItem('notes-app:mobile:displayMode')).toBe('grid');
  });
});

describe('favourites', () => {
  it('isFavourite reads from the tree store', () => {
    tree.notesById = { n1: { favourite: true }, n2: { favourite: false } };
    expect(isFavourite('n1')).toBe(true);
    expect(isFavourite('n2')).toBe(false);
    expect(isFavourite('missing')).toBe(false);
  });

  it('toggleFavourite flips the current value through the tree store', () => {
    tree.notesById = { n1: { favourite: false } };
    toggleFavourite('n1');
    expect(setNoteFavourite).toHaveBeenCalledWith('n1', true);
  });
});

describe('migrateLegacyFavourites', () => {
  it('hoists legacy ids that are not already favourited, then clears the key', async () => {
    tree.notesById = { a: { favourite: false }, b: { favourite: true } };
    localStorage.setItem(
      'notes-app:mobile:favourites',
      JSON.stringify(['a', 'b', 'missing'])
    );
    await migrateLegacyFavourites();
    expect(setNoteFavourite).toHaveBeenCalledWith('a', true);
    expect(setNoteFavourite).not.toHaveBeenCalledWith('b', true);
    expect(localStorage.getItem('notes-app:mobile:favourites')).toBeNull();
  });

  it('drops a malformed legacy payload without writing anything', async () => {
    localStorage.setItem('notes-app:mobile:favourites', '{not json');
    await migrateLegacyFavourites();
    expect(setNoteFavourite).not.toHaveBeenCalled();
    expect(localStorage.getItem('notes-app:mobile:favourites')).toBeNull();
  });

  it('is a no-op when there is no legacy key', async () => {
    await migrateLegacyFavourites();
    expect(setNoteFavourite).not.toHaveBeenCalled();
  });
});

describe('history navigation', () => {
  it('navigateToEditor activates the note, switches screen and pushes history', () => {
    navigateToEditor('n9');
    expect(setActiveNote).toHaveBeenCalledWith('n9');
    expect(mobileState.screen).toBe('editor');
    expect(pushState).toHaveBeenCalledWith('', {});
  });

  it('navigateBack delegates to window.history.back', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    navigateBack();
    expect(back).toHaveBeenCalled();
    back.mockRestore();
  });

  it('installMobileHistoryNav returns home on popstate and is idempotent', () => {
    const cleanup = installMobileHistoryNav();
    mobileState.screen = 'editor';
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(mobileState.screen).toBe('home');

    // Second install while one is active is a no-op cleanup.
    const noop = installMobileHistoryNav();
    expect(typeof noop).toBe('function');
    cleanup();
  });
});
