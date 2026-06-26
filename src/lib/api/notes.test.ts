import { describe, expect, it } from 'vitest';
import {
  createNote,
  isKnownNoteKind,
  KNOWN_NOTE_KINDS,
  listNotes,
  loadNote,
  purgeNote,
  restoreNote,
  saveNote,
  trashNote
} from './notes';

// Outside Tauri these wrappers resolve through invokeOrFallback into the
// in-memory mock store, so the whole notes API surface is exercisable.

describe('isKnownNoteKind', () => {
  it('accepts every known kind', () => {
    for (const kind of KNOWN_NOTE_KINDS) {
      expect(isKnownNoteKind(kind)).toBe(true);
    }
  });

  it('rejects unknown values and nullish input', () => {
    expect(isKnownNoteKind('hologram')).toBe(false);
    expect(isKnownNoteKind(null)).toBe(false);
    expect(isKnownNoteKind(undefined)).toBe(false);
  });
});

describe('notes API (browser fallback)', () => {
  it('creates, loads and lists a note', async () => {
    const created = await createNote({ title: 'API note', body: 'hi' });
    expect(created.id).toBeTruthy();

    const loaded = await loadNote(created.id);
    expect(loaded.title).toBe('API note');
    expect(loaded.body).toBe('hi');

    const list = await listNotes(false);
    expect(list.some((n) => n.id === created.id)).toBe(true);
  });

  it('saves edits', async () => {
    const created = await createNote({ title: 'before' });
    const saved = await saveNote({ id: created.id, title: 'after' });
    expect(saved.title).toBe('after');
  });

  it('trashes, hides from the default list, then restores', async () => {
    const created = await createNote({ title: 'temp' });
    await trashNote(created.id);
    expect((await listNotes(false)).some((n) => n.id === created.id)).toBe(
      false
    );
    expect((await listNotes(true)).some((n) => n.id === created.id)).toBe(true);

    await restoreNote(created.id);
    expect((await listNotes(false)).some((n) => n.id === created.id)).toBe(
      true
    );
  });

  it('purges a note permanently', async () => {
    const created = await createNote({ title: 'doomed' });
    await purgeNote(created.id);
    await expect(loadNote(created.id)).rejects.toThrow();
  });
});
