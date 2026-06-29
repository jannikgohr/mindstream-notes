import { describe, expect, it } from 'vitest';
import { createNote, saveNote } from './notes';
import {
  captureCurrentNoteVersion,
  captureNoteVersion,
  listNoteVersions,
  loadNoteVersion,
  pruneNoteVersions
} from './history';

describe('note history API (browser fallback)', () => {
  it('captures, lists and loads markdown versions', async () => {
    const note = await createNote({
      title: 'History wrapper',
      body: 'first draft'
    });

    const first = await captureNoteVersion(
      note.id,
      'markdown',
      'edited',
      'first draft'
    );
    const second = await captureNoteVersion(
      note.id,
      'markdown',
      'edited',
      'second draft'
    );

    expect(first?.action).toBe('created');
    expect(second?.action).toBe('edited');
    expect(
      await captureNoteVersion(note.id, 'markdown', 'edited', 'second draft')
    ).toBeNull();

    const versions = await listNoteVersions(note.id);
    expect(versions.map((version) => version.id)).toEqual([
      second?.id,
      first?.id
    ]);

    const loaded = await loadNoteVersion(first!.id);
    expect(loaded.body).toBe('first draft');
  });

  it('captures the current saved note state and keeps forever on null prune', async () => {
    const note = await createNote({
      title: 'Current history wrapper',
      body: 'saved state'
    });
    await saveNote({ id: note.id, body: 'saved state updated' });

    const version = await captureCurrentNoteVersion(note.id, 'edited');

    expect(version?.action).toBe('created');
    expect((await loadNoteVersion(version!.id)).body).toBe(
      'saved state updated'
    );
    expect(await pruneNoteVersions(null)).toBe(0);
  });
});
