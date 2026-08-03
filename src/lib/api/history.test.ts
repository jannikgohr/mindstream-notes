import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import { createNote, saveNote } from './notes';
import {
  captureCurrentNoteVersion,
  captureNoteVersion,
  listNoteVersions,
  loadNoteVersion,
  pruneNoteVersions,
  VersionActionEnum
} from './history';

function setTauri(on: boolean): void {
  if (on)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

const SUMMARY = {
  id: 'v1',
  note_id: 'n1',
  created: '2026-01-01T00:00:00Z',
  note_kind: 'markdown',
  action: VersionActionEnum.Edited,
  label: null,
  ref_version_id: null,
  ref_created: null,
  words_added: 3,
  words_removed: 1,
  tokens_added: 10,
  tokens_removed: 2,
  size: 42
};

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

describe('note history — input validation', () => {
  it('rejects malformed capture arguments', () => {
    expect(() => captureNoteVersion('', 'markdown', 'edited', 's')).toThrow(
      /noteId must be a non-empty/
    );
    expect(() =>
      captureNoteVersion('n1', 'bogus' as never, 'edited', 's')
    ).toThrow(/not a supported note kind/);
    expect(() =>
      captureNoteVersion('n1', 'markdown', 'bogus' as never, 's')
    ).toThrow(/not a known version action/);
    expect(() => captureCurrentNoteVersion('', 'edited')).toThrow(
      /noteId must be a non-empty/
    );
    expect(() => listNoteVersions('')).toThrow(/noteId must be a non-empty/);
    expect(() => loadNoteVersion('')).toThrow(/versionId must be a non-empty/);
  });

  it('pruneNoteVersions rejects a non-finite retention', () => {
    expect(() => pruneNoteVersions(Infinity)).toThrow(/must be null or finite/);
  });
});

describe('note history — Tauri parse path', () => {
  beforeEach(() => {
    setTauri(true);
    invoke.mockReset();
  });
  afterEach(() => setTauri(false));

  it('listNoteVersions parses summaries and rejects non-arrays', async () => {
    invoke.mockResolvedValueOnce([SUMMARY]);
    const versions = await listNoteVersions('n1');
    expect(versions[0].id).toBe('v1');
    expect(versions[0].action).toBe('edited');
    invoke.mockResolvedValueOnce({});
    await expect(listNoteVersions('n1')).rejects.toThrow(/must be an array/);
  });

  it('loadNoteVersion parses a full version with a body', async () => {
    invoke.mockResolvedValue({ ...SUMMARY, body: 'snapshot text' });
    const version = await loadNoteVersion('v1');
    expect(version.body).toBe('snapshot text');
  });

  it('captureNoteVersion parses null (no-op) and a returned summary', async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(
      captureNoteVersion('n1', 'markdown', 'edited', 's')
    ).resolves.toBeNull();
    invoke.mockResolvedValueOnce({ ...SUMMARY, action: 'created' });
    const summary = await captureNoteVersion('n1', 'markdown', 'created', 's');
    expect(summary?.action).toBe('created');
  });

  it('rejects a version with an unknown action or note kind', async () => {
    invoke.mockResolvedValueOnce({ ...SUMMARY, action: 'destroyed' });
    await expect(loadNoteVersion('v1')).rejects.toThrow(
      /not a known version action/
    );
    invoke.mockResolvedValueOnce({ ...SUMMARY, note_kind: 'bogus', body: 'b' });
    await expect(loadNoteVersion('v1')).rejects.toThrow(
      /not a supported note kind/
    );
  });
});
