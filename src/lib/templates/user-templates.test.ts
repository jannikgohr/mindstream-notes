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
// A minimal interpolation so we can assert it runs without pulling the registry,
// plus the open-on-create convention reader.
vi.mock('$lib/plugins/templates', () => ({
  renderTemplateString: (tpl: string, ctx: Record<string, string>) =>
    tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) =>
      k === 'date' ? '2026-07-26' : (ctx[k] ?? '')
    ),
  shouldOpenOnCreate: (pluginId: string) =>
    settings.get(`plugins.${pluginId}.open-on-create`) !== false
}));

import {
  TEMPLATES_PLUGIN_ID,
  createNoteFromUserTemplate,
  hasUserTemplates,
  userTemplateEntries
} from './user-templates';

const FOLDER_KEY = `plugins.${TEMPLATES_PLUGIN_ID}.source-folder`;
const TAG_KEY = `plugins.${TEMPLATES_PLUGIN_ID}.source-tag`;
const OPEN_KEY = `plugins.${TEMPLATES_PLUGIN_ID}.open-on-create`;

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

  it('includes markdown notes inside the source folder id (nested)', () => {
    settings.set(FOLDER_KEY, 'root');
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
    settings.set(TAG_KEY, 'tpl');
    state.notesById = {
      a: note('a', { title: 'Tagged', tags: ['tpl', 'x'] }),
      b: note('b', { title: 'Untagged', tags: ['x'] })
    };
    const entries = userTemplateEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: 'Tagged', source: 'tag' });
  });

  it('excludes trashed notes and non-markdown kinds', () => {
    settings.set(TAG_KEY, 'tpl');
    state.notesById = {
      a: note('a', { tags: ['tpl'], trashed: true }),
      b: note('b', { tags: ['tpl'], note_kind: 'kanban' }),
      c: note('c', { title: 'Keep', tags: ['tpl'] })
    };
    expect(userTemplateEntries().map((e) => e.label)).toEqual(['Keep']);
  });

  it('sorts entries by label', () => {
    settings.set(TAG_KEY, 'tpl');
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

  it('respects the open-on-create toggle when creating', async () => {
    state.notesById = { src: note('src', { title: 'T' }) };
    loadNote.mockResolvedValue({ body: 'b' });
    settings.set(OPEN_KEY, false);

    await createNoteFromUserTemplate('src', null);

    expect(createNoteIn).toHaveBeenCalled();
    expect(requestOpenNote).not.toHaveBeenCalled();
  });
});
