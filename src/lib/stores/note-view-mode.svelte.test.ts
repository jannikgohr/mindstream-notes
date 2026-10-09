import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNoteViewMode,
  getNoteViewMode,
  noteViewMode,
  setNoteViewMode
} from './note-view-mode.svelte';

beforeEach(() => {
  for (const key of Object.keys(noteViewMode)) delete noteViewMode[key];
});

describe('setNoteViewMode / getNoteViewMode', () => {
  it('stores and reads back a control by note id', () => {
    const onCycle = vi.fn();
    setNoteViewMode('n1', { value: 'source', onCycle });
    const read = getNoteViewMode('n1');
    expect(read?.value).toBe('source');
    read?.onCycle();
    expect(onCycle).toHaveBeenCalledTimes(1);
  });

  it('keeps each note on its own control', () => {
    setNoteViewMode('n1', { value: 'source', onCycle: () => {} });
    setNoteViewMode('n2', { value: 'split', onCycle: () => {} });
    expect(getNoteViewMode('n1')?.value).toBe('source');
    expect(getNoteViewMode('n2')?.value).toBe('split');
  });

  it('returns null for null/undefined/unknown ids', () => {
    expect(getNoteViewMode(null)).toBeNull();
    expect(getNoteViewMode(undefined)).toBeNull();
    expect(getNoteViewMode('never-set')).toBeNull();
  });
});

describe('clearNoteViewMode', () => {
  it('removes the entry so the header stops rendering the toggle', () => {
    setNoteViewMode('n1', { value: 'wysiwyg', onCycle: () => {} });
    clearNoteViewMode('n1');
    expect(getNoteViewMode('n1')).toBeNull();
    expect('n1' in noteViewMode).toBe(false);
  });
});
