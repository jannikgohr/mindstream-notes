import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import {
  createNote,
  isKnownNoteKind,
  isPluginNoteKind,
  parsePluginNoteKind,
  isSupportedNoteKind,
  KNOWN_NOTE_KINDS,
  listNotes,
  loadNote,
  purgeNote,
  restoreNote,
  saveNote,
  trashNote
} from './notes';

function setTauri(on: boolean): void {
  if (on)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

const SUMMARY = {
  id: 'n1',
  parent_collection_id: null,
  title: 'Note',
  position: 0,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
  tags: ['x'],
  trashed: false,
  favourite: false,
  pushed: true,
  note_kind: 'markdown'
};
const NOTE = { ...SUMMARY, body: 'hi', yrs_state: [1, 2], payload_schema: 2 };

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

  it('includes the kanban board kind', () => {
    expect(KNOWN_NOTE_KINDS).toContain('kanban');
    expect(isKnownNoteKind('kanban')).toBe(true);
  });
});

describe('isPluginNoteKind / isSupportedNoteKind', () => {
  it('accepts a well-formed plugin note kind', () => {
    expect(isPluginNoteKind('plugin.com.example.typst.document')).toBe(true);
    expect(isSupportedNoteKind('plugin.com.example.typst.document')).toBe(true);
  });

  it('rejects malformed or over-long plugin kinds', () => {
    expect(isPluginNoteKind('typst')).toBe(false); // no plugin. prefix
    expect(isPluginNoteKind('plugin.only.two')).toBe(false); // < 3 segments
    expect(isPluginNoteKind('plugin.com.Example.X')).toBe(false); // uppercase segment
    expect(isPluginNoteKind('plugin.' + 'a.'.repeat(90) + 'b')).toBe(false); // > 160
    expect(isPluginNoteKind(null)).toBe(false);
  });

  it('isSupportedNoteKind covers both built-in and plugin kinds', () => {
    expect(isSupportedNoteKind('markdown')).toBe(true);
    expect(isSupportedNoteKind('nope')).toBe(false);
  });
});

describe('parsePluginNoteKind', () => {
  it('recovers the owner and local kind from a stored plugin note kind', () => {
    expect(parsePluginNoteKind('plugin.com.mindstream.typst.document')).toEqual(
      {
        pluginId: 'com.mindstream.typst',
        localKindId: 'document'
      }
    );
  });

  it('rejects built-in and malformed note kinds', () => {
    expect(parsePluginNoteKind('markdown')).toBeNull();
    expect(parsePluginNoteKind('plugin.only.two')).toBeNull();
  });
});

describe('input validation', () => {
  it('createNote rejects malformed fields', () => {
    expect(() => createNote({ title: 5 as unknown as string })).toThrow(
      /title must be a string/
    );
    expect(() => createNote({ body: 5 as unknown as string })).toThrow(
      /body must be a string/
    );
    expect(() =>
      createNote({ parent_collection_id: 5 as unknown as string })
    ).toThrow(/parent_collection_id must be a string or null/);
    expect(() =>
      createNote({ note_kind: 'hologram' as unknown as never })
    ).toThrow(/not a supported note kind/);
  });

  it('saveNote rejects malformed fields', () => {
    expect(() => saveNote({ id: '' })).toThrow(/id must be a non-empty/);
    expect(() => saveNote({ id: 'n1', title: 5 as unknown as string })).toThrow(
      /title must be a string/
    );
    expect(() => saveNote({ id: 'n1', position: Infinity })).toThrow(
      /position must be finite/
    );
    expect(() =>
      saveNote({ id: 'n1', tags: 'x' as unknown as string[] })
    ).toThrow(/tags must be an array/);
    expect(() =>
      saveNote({ id: 'n1', yrs_state: 'x' as unknown as number[] })
    ).toThrow(/yrs_state must be an array/);
    expect(() =>
      saveNote({ id: 'n1', favourite: 'x' as unknown as boolean })
    ).toThrow(/favourite must be a boolean/);
  });
});

describe('notes api (Tauri parse path)', () => {
  beforeEach(() => {
    setTauri(true);
    invoke.mockReset();
  });
  afterEach(() => setTauri(false));

  it('loadNote parses a full note', async () => {
    invoke.mockResolvedValue(NOTE);
    const note = await loadNote('n1');
    expect(note.id).toBe('n1');
    expect(note.body).toBe('hi');
    expect(note.yrs_state).toEqual([1, 2]);
  });

  it('listNotes parses a summary array and rejects non-arrays', async () => {
    invoke.mockResolvedValueOnce([SUMMARY]);
    await expect(listNotes()).resolves.toHaveLength(1);
    invoke.mockResolvedValueOnce({});
    await expect(listNotes()).rejects.toThrow(/must be an array/);
  });

  it('parseNoteSummary rejects an unsupported note kind', async () => {
    invoke.mockResolvedValue({ ...NOTE, note_kind: 'bogus' });
    await expect(loadNote('n1')).rejects.toThrow(/not a supported note kind/);
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
