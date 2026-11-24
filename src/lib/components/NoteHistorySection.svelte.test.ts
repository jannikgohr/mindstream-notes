import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VersionSummary } from '$lib/api';

const api = vi.hoisted(() => ({
  listNoteVersions: vi.fn(),
  loadNote: vi.fn(),
  loadNoteVersion: vi.fn()
}));
vi.mock('$lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api')>()),
  ...api
}));
vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/platform')>()),
  isMobile: () => true
}));
// Desktop only; its editor stack is heavy to load in tests.
vi.mock('$lib/components/NoteHistoryModal.svelte', () => ({
  default: () => {}
}));

import NoteHistorySection from './NoteHistorySection.svelte';

const version: VersionSummary = {
  id: 'v1',
  note_id: 'n1',
  created: '2026-11-20T10:00:00Z',
  note_kind: 'markdown',
  action: 'edited',
  label: null,
  ref_version_id: null,
  ref_created: null,
  words_added: 0,
  words_removed: 0,
  tokens_added: 0,
  tokens_removed: 0,
  size: 0
};

afterEach(cleanup);

describe('NoteHistorySection on mobile', () => {
  it('diffs an older version against the note as it is now', async () => {
    api.listNoteVersions.mockResolvedValue([version]);
    api.loadNoteVersion.mockResolvedValue({ body: 'one\ntwo\nthree' });
    api.loadNote.mockResolvedValue({ body: 'one\n2\nthree' });
    render(NoteHistorySection, { noteId: 'n1', noteKind: 'markdown' });

    await fireEvent.click(
      await screen.findByRole('button', { name: /Edited/ })
    );

    expect(await screen.findByText('+1 added')).toBeTruthy();
    expect(screen.getByText('−1 removed')).toBeTruthy();
  });
});
