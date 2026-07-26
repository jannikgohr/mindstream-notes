import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, test-controlled state for the mocked stores.
const { state, loadNote, createNoteIn, requestOpenNote, settings } = vi.hoisted(
  () => ({
    state: {
      notesById: {} as Record<string, unknown>,
      collectionsById: {} as Record<string, unknown>
    },
    loadNote: vi.fn(),
    createNoteIn: vi.fn(),
    requestOpenNote: vi.fn(),
    settings: new Map<string, unknown>()
  })
);

vi.mock('$lib/api/notes', () => ({
  NoteKind: { Markdown: 'markdown', Kanban: 'kanban' },
  loadNote
}));
vi.mock('$lib/stores/tree.svelte', () => ({ tree: state, createNoteIn }));
vi.mock('$lib/stores/open-note-intent.svelte', () => ({ requestOpenNote }));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) => settings.get(id)
}));
// A minimal interpolation so we can assert it runs without pulling the registry.
vi.mock('$lib/plugins/templates', () => ({
  renderTemplateString: (tpl: string, ctx: Record<string, string>) =>
    tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) =>
      k === 'date' ? '2026-07-26' : (ctx[k] ?? '')
    )
}));

import {
  TEMPLATE_SHOW_BUILTIN,
  TEMPLATE_SOURCE_FOLDER,
  TEMPLATE_SOURCE_TAG,
  createNoteFromUserTemplate,
  hasUserTemplates,
  showBuiltInTemplates,
  userTemplateEntries
} from './user-templates';

function note(
  id: string,
  over: Partial<{
    title: string;
    tags: string[];
    note_kind: string;
    trashed: boolean;
    parent: string | null;
  }> = {}
) {
  return {
    id,
    title: over.title ?? id,
    tags: over.tags ?? [],
    note_kind: over.note_kind ?? 'markdown',
    trashed: over.trashed ?? false,
    parent_collection_id: over.parent ?? null
  };
}

function folder(id: string, name: string, parent: string | null = null) {
  return { id, name, parent_collection_id: parent };
}

beforeEach(() => {
  state.notesById = {};
  state.collectionsById = {};
  settings.clear();
  loadNote.mockReset();
  createNoteIn.mockReset().mockResolvedValue('new-note');
  requestOpenNote.mockReset();
});

describe('userTemplateEntries', () => {
  it('is empty when neither source is configured', () => {
    state.notesById = { n1: note('n1', { tags: ['t'] }) };
    expect(userTemplateEntries()).toEqual([]);
    expect(hasUserTemplates()).toBe(false);
  });

  it('includes markdown notes under a folder with the source name (nested)', () => {
    settings.set(TEMPLATE_SOURCE_FOLDER, 'Templates');
    state.collectionsById = {
      root: folder('root', 'Templates'),
      sub: folder('sub', 'Drafts', 'root')
    };
    state.notesById = {
      a: note('a', { title: 'Direct', parent: 'root' }),
      b: note('b', { title: 'Nested', parent: 'sub' }),
      c: note('c', { title: 'Outside', parent: null })
    };
    const labels = userTemplateEntries().map((e) => e.label);
    expect(labels).toEqual(['Direct', 'Nested']);
  });

  it('includes notes carrying the source tag', () => {
    settings.set(TEMPLATE_SOURCE_TAG, 'tpl');
    state.notesById = {
      a: note('a', { title: 'Tagged', tags: ['tpl', 'x'] }),
      b: note('b', { title: 'Untagged', tags: ['x'] })
    };
    const entries = userTemplateEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: 'Tagged', source: 'tag' });
  });

  it('excludes trashed notes and non-markdown kinds', () => {
    settings.set(TEMPLATE_SOURCE_TAG, 'tpl');
    state.notesById = {
      a: note('a', { tags: ['tpl'], trashed: true }),
      b: note('b', { tags: ['tpl'], note_kind: 'kanban' }),
      c: note('c', { title: 'Keep', tags: ['tpl'] })
    };
    expect(userTemplateEntries().map((e) => e.label)).toEqual(['Keep']);
  });

  it('sorts entries by label', () => {
    settings.set(TEMPLATE_SOURCE_TAG, 'tpl');
    state.notesById = {
      a: note('a', { title: 'Zebra', tags: ['tpl'] }),
      b: note('b', { title: 'Apple', tags: ['tpl'] })
    };
    expect(userTemplateEntries().map((e) => e.label)).toEqual([
      'Apple',
      'Zebra'
    ]);
  });
});

describe('showBuiltInTemplates', () => {
  it('defaults to true and honours an explicit false', () => {
    expect(showBuiltInTemplates()).toBe(true);
    settings.set(TEMPLATE_SHOW_BUILTIN, false);
    expect(showBuiltInTemplates()).toBe(false);
  });
});

describe('createNoteFromUserTemplate', () => {
  it('interpolates the source body/title and creates + opens the note', async () => {
    state.notesById = { src: note('src', { title: 'Daily {{date}}' }) };
    loadNote.mockResolvedValue({ body: '# {{title}}\n\n{{date}}' });

    const id = await createNoteFromUserTemplate('src', 'col-1');

    expect(id).toBe('new-note');
    expect(createNoteIn).toHaveBeenCalledWith(
      'col-1',
      'Daily 2026-07-26',
      'markdown',
      '# Daily 2026-07-26\n\n2026-07-26'
    );
    expect(requestOpenNote).toHaveBeenCalledWith('new-note');
  });
});
