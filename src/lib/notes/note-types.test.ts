import { beforeEach, describe, expect, it, vi } from 'vitest';

// The helper reads settings through the store; drive it with a mock so we can
// flip individual toggles without a live settings runtime.
const values = new Map<string, unknown>();
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) => values.get(id)
}));

import { noteTypeEnabled } from './note-types';

describe('noteTypeEnabled', () => {
  beforeEach(() => values.clear());

  it('always enables markdown regardless of settings', () => {
    values.set('editor.noteTypes.markdown', false);
    expect(noteTypeEnabled('markdown')).toBe(true);
  });

  it('defaults optional kinds to enabled when the toggle is unset', () => {
    expect(noteTypeEnabled('kanban')).toBe(true);
    expect(noteTypeEnabled('freeform')).toBe(true);
    expect(noteTypeEnabled('pdf')).toBe(true);
  });

  it('hides a kind only when its toggle is explicitly false', () => {
    values.set('editor.noteTypes.kanban', false);
    expect(noteTypeEnabled('kanban')).toBe(false);
    values.set('editor.noteTypes.kanban', true);
    expect(noteTypeEnabled('kanban')).toBe(true);
  });
});
