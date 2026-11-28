import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  state,
  createNoteIn,
  requestOpenNote,
  renderUserTemplateBody,
  templatesEnabled
} = vi.hoisted(() => ({
  state: {
    notesById: {} as Record<string, unknown>,
    collectionsById: {} as Record<string, unknown>
  },
  createNoteIn: vi.fn(),
  requestOpenNote: vi.fn(),
  renderUserTemplateBody: vi.fn(),
  templatesEnabled: { value: true }
}));

vi.mock('$lib/stores/tree.svelte', () => ({ tree: state, createNoteIn }));
vi.mock('$lib/stores/open-note-intent.svelte', () => ({ requestOpenNote }));
vi.mock('$lib/templates/user-templates', () => ({
  renderUserTemplateBody,
  TEMPLATES_PLUGIN_ID: 'templates'
}));
vi.mock('./registry.svelte', () => ({
  pluginById: (id: string) =>
    id === 'templates' ? { enabled: templatesEnabled.value } : undefined
}));

import { openOrCreateNote } from './open-or-create';

function note(
  id: string,
  title: string,
  parent: string | null,
  over: Partial<{ trashed: boolean; note_kind: string }> = {}
) {
  return {
    id,
    title,
    parent_collection_id: parent,
    trashed: over.trashed ?? false,
    note_kind: over.note_kind ?? 'markdown'
  };
}

beforeEach(() => {
  state.notesById = {};
  state.collectionsById = { journal: { id: 'journal' } };
  createNoteIn.mockReset().mockResolvedValue('new-note');
  requestOpenNote.mockReset();
  renderUserTemplateBody.mockReset();
  templatesEnabled.value = true;
});

describe('openOrCreateNote', () => {
  it('opens the live note with that title in that folder', async () => {
    state.notesById = {
      elsewhere: note('elsewhere', '2026-11-23', null),
      trashed: note('trashed', '2026-11-23', 'journal', { trashed: true }),
      daily: note('daily', '2026-11-23', 'journal')
    };

    const id = await openOrCreateNote({
      title: '2026-11-23',
      parentId: 'journal'
    });

    expect(id).toBe('daily');
    expect(createNoteIn).not.toHaveBeenCalled();
    expect(requestOpenNote).toHaveBeenCalledWith('daily');
  });

  // Its tags argument is `[]`: a journal entry doesn't take the tag filter.
  it('creates a blank markdown note when there is none', async () => {
    await openOrCreateNote({ title: 'Day', parentId: 'journal' });

    expect(createNoteIn).toHaveBeenCalledWith(
      'journal',
      'Day',
      'markdown',
      undefined,
      []
    );
    expect(requestOpenNote).toHaveBeenCalledWith('new-note');
  });

  it('renders the template for the given day, titled as the new note', async () => {
    state.notesById = {
      tpl: note('tpl', 'Template', null, { note_kind: 'kanban' })
    };
    renderUserTemplateBody.mockResolvedValue('rendered');

    await openOrCreateNote({
      title: '2026-11-23',
      parentId: 'journal',
      template: { sourceNoteId: 'tpl', date: '2026-11-23' }
    });

    const [templateId, anchor, title] = renderUserTemplateBody.mock.calls[0];
    expect(templateId).toBe('tpl');
    expect(title).toBe('2026-11-23');
    expect([anchor.getFullYear(), anchor.getMonth(), anchor.getDate()]).toEqual(
      [2026, 10, 23]
    );
    expect(createNoteIn).toHaveBeenCalledWith(
      'journal',
      '2026-11-23',
      'kanban',
      'rendered',
      []
    );
  });

  it('creates a blank note when the template is gone', async () => {
    await openOrCreateNote({
      title: 'Day',
      parentId: null,
      template: { sourceNoteId: 'gone' }
    });

    expect(renderUserTemplateBody).not.toHaveBeenCalled();
    expect(createNoteIn).toHaveBeenCalledWith(
      null,
      'Day',
      'markdown',
      undefined,
      []
    );
  });

  it('creates a blank note when the Templates plugin is disabled', async () => {
    state.notesById = { tpl: note('tpl', 'Template', null) };
    templatesEnabled.value = false;

    await openOrCreateNote({
      title: 'Day',
      parentId: null,
      template: { sourceNoteId: 'tpl' }
    });

    expect(renderUserTemplateBody).not.toHaveBeenCalled();
    expect(createNoteIn).toHaveBeenCalledWith(
      null,
      'Day',
      'markdown',
      undefined,
      []
    );
  });

  it('creates one note when the same note is asked for twice at once', async () => {
    const ids = await Promise.all([
      openOrCreateNote({ title: 'Day', parentId: 'journal' }),
      openOrCreateNote({ title: 'Day', parentId: 'journal' })
    ]);

    expect(ids).toEqual(['new-note', 'new-note']);
    expect(createNoteIn).toHaveBeenCalledTimes(1);
  });
});
