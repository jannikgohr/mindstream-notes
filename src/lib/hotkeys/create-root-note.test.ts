import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { createNoteIn } from '$lib/stores/tree.svelte';
import { createRootNote } from './create-root-note';

vi.mock('$lib/stores/open-note-intent.svelte', () => ({
  requestOpenNote: vi.fn()
}));

vi.mock('$lib/stores/tree.svelte', () => ({
  createNoteIn: vi.fn()
}));

const createNoteInMock = vi.mocked(createNoteIn);
const requestOpenNoteMock = vi.mocked(requestOpenNote);

beforeEach(() => {
  createNoteInMock.mockReset();
  requestOpenNoteMock.mockReset();
  createNoteInMock.mockResolvedValue('note-new');
});

describe('createRootNote', () => {
  it.each([
    ['markdown', 'Untitled'],
    ['freeform', 'Untitled drawing canvas'],
    ['ink', 'Untitled handwritten note'],
    ['kanban', 'Untitled board']
  ] as const)('creates and opens a %s root note', async (kind, title) => {
    await createRootNote(kind);

    expect(createNoteInMock).toHaveBeenCalledWith(null, title, kind);
    expect(requestOpenNoteMock).toHaveBeenCalledWith('note-new');
  });
});
