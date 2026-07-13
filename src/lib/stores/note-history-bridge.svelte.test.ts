import { describe, expect, it, vi } from 'vitest';
import {
  bumpNoteHistory,
  clearRestoreUndo,
  getNoteHistory,
  installNoteHistoryE2EDiagnostics,
  noteHistoryEpoch,
  noteRestoreUndo,
  registerNoteHistory,
  registeredNotes,
  setRestoreUndo
} from './note-history-bridge.svelte';

const api = () => ({
  restoreSnapshot: vi.fn(),
  currentSnapshot: () => 'snapshot',
  snapshotNow: vi.fn().mockResolvedValue(undefined)
});

describe('note-history-bridge', () => {
  it('registers, exposes the api, and marks the note as available', () => {
    const a = api();
    const off = registerNoteHistory('n1', a);
    expect(getNoteHistory('n1')).toBe(a);
    expect(registeredNotes.has('n1')).toBe(true);
    off();
    expect(getNoteHistory('n1')).toBeNull();
    expect(registeredNotes.has('n1')).toBe(false);
  });

  it('a stale unsubscribe does not clobber a remounted editor', () => {
    const first = api();
    const offFirst = registerNoteHistory('n2', first);
    const second = api();
    registerNoteHistory('n2', second); // remount replaces the entry
    offFirst(); // late teardown of the first instance must be a no-op
    expect(getNoteHistory('n2')).toBe(second);
    expect(registeredNotes.has('n2')).toBe(true);
  });

  it('bumps a per-note epoch so the sidebar can react to captures', () => {
    const before = noteHistoryEpoch('n3');
    bumpNoteHistory('n3');
    expect(noteHistoryEpoch('n3')).toBe(before + 1);
    // Independent per note.
    expect(noteHistoryEpoch('other')).toBe(0);
  });

  it('stores and clears pending restore undo state per note', () => {
    expect(noteRestoreUndo('n4')).toBeNull();

    setRestoreUndo('n4', { body: 'before restore', checkpointId: 'ver_1' });

    expect(noteRestoreUndo('n4')).toEqual({
      body: 'before restore',
      checkpointId: 'ver_1'
    });
    expect(noteRestoreUndo('other')).toBeNull();

    clearRestoreUndo('n4');
    expect(noteRestoreUndo('n4')).toBeNull();
  });

  it('installs E2E diagnostics for peer count and collab pause control', async () => {
    const setCollabPaused = vi.fn().mockResolvedValue(undefined);
    const off = registerNoteHistory('n5', {
      ...api(),
      peerCount: () => 2,
      setCollabPaused
    });
    const target: Pick<Window, '__mindstreamE2E'> = {};

    installNoteHistoryE2EDiagnostics(target);

    expect(target.__mindstreamE2E?.notePeerCount('n5')).toBe(2);
    expect(target.__mindstreamE2E?.notePeerCount('missing')).toBe(0);

    await target.__mindstreamE2E?.setNoteCollabPaused('n5', true);
    expect(setCollabPaused).toHaveBeenCalledWith(true);

    await expect(
      target.__mindstreamE2E?.setNoteCollabPaused('missing', false)
    ).rejects.toThrow('note missing has no collab pause hook');

    off();
  });
});
