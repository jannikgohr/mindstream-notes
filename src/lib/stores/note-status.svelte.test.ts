import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearNoteStatus,
  getNoteStatus,
  noteStatus,
  setNoteStatus,
  type NoteStatus
} from './note-status.svelte';

const status = (over: Partial<NoteStatus> = {}): NoteStatus => ({
  collabConfigured: false,
  collabOnline: false,
  savingState: 'idle',
  isTrashed: false,
  ...over
});

beforeEach(() => {
  for (const key of Object.keys(noteStatus)) delete noteStatus[key];
});

describe('setNoteStatus / getNoteStatus', () => {
  it('stores and reads back a status by note id', () => {
    setNoteStatus('n1', status({ savingState: 'saving', collabOnline: true }));
    const read = getNoteStatus('n1');
    expect(read.savingState).toBe('saving');
    expect(read.collabOnline).toBe(true);
  });

  it('returns the empty placeholder for null/undefined/unknown ids', () => {
    const empty = status();
    expect(getNoteStatus(null)).toEqual(empty);
    expect(getNoteStatus(undefined)).toEqual(empty);
    expect(getNoteStatus('never-set')).toEqual(empty);
  });
});

describe('clearNoteStatus', () => {
  it('removes the entry so it falls back to empty', () => {
    setNoteStatus('n1', status({ isTrashed: true }));
    clearNoteStatus('n1');
    expect(getNoteStatus('n1').isTrashed).toBe(false);
    expect('n1' in noteStatus).toBe(false);
  });
});
