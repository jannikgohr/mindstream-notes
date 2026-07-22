import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSavedLayout,
  loadSavedLayout,
  saveLayout,
  validateSavedLayout
} from './layout';

const dock = {
  grid: {
    root: {
      type: 'leaf',
      data: { id: 'group-1', views: ['note:a'], activeView: 'note:a' }
    },
    width: 800,
    height: 600,
    orientation: 0
  },
  panels: {
    'note:a': {
      id: 'note:a',
      component: 'noteEditor',
      title: 'A',
      params: { noteId: 'a' }
    }
  }
};

beforeEach(() => localStorage.clear());

describe('dock layout persistence', () => {
  it('saves and loads layouts per vault', () => {
    saveLayout('default', dock, 'a');
    saveLayout(
      'work',
      { ...dock, panels: { 'note:b': { params: { noteId: 'b' } } } },
      'b'
    );

    expect(loadSavedLayout('default')?.activeNoteId).toBe('a');
    expect(loadSavedLayout('work')?.activeNoteId).toBe('b');
  });

  it('falls back to the legacy key only for the default vault', () => {
    localStorage.setItem(
      'notes-app:dock-layout:v1',
      JSON.stringify({
        version: 1,
        dock,
        activeNoteId: 'a',
        savedAt: '2026-01-01T00:00:00.000Z'
      })
    );

    expect(loadSavedLayout('default')?.activeNoteId).toBe('a');
    expect(loadSavedLayout('work')).toBeNull();
  });

  it('clears only the requested vault layout', () => {
    saveLayout('default', dock, 'a');
    saveLayout('work', dock, 'a');

    clearSavedLayout('work');

    expect(loadSavedLayout('default')).not.toBeNull();
    expect(loadSavedLayout('work')).toBeNull();
  });

  it('rejects malformed saved layout blobs', () => {
    expect(validateSavedLayout(null)).toBeNull();
    expect(validateSavedLayout({ version: 1, dock: null })).toBeNull();
    expect(
      validateSavedLayout({
        version: 1,
        dock,
        activeNoteId: 123,
        savedAt: '2026-01-01T00:00:00.000Z'
      })
    ).toBeNull();
    expect(
      validateSavedLayout({
        version: 1,
        dock,
        activeNoteId: 'a',
        savedAt: 'not a timestamp'
      })
    ).toBeNull();
  });

  it('returns a normalized saved layout without extra top-level fields', () => {
    const saved = validateSavedLayout({
      version: 1,
      dock,
      activeNoteId: null,
      savedAt: '2026-01-01T00:00:00.000Z',
      unexpected: true
    });

    expect(saved).toEqual({
      version: 1,
      dock,
      activeNoteId: null,
      savedAt: '2026-01-01T00:00:00.000Z'
    });
  });
});
