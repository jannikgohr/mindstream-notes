import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { writeBoardToYDoc } from '$lib/kanban/kanban-yjs';

const state = vi.hoisted(() => ({
  notes: {} as Record<string, Record<string, unknown>>,
  collections: {},
  loadNote: vi.fn(),
  writeExportFile: vi.fn()
}));
vi.mock('$lib/api', () => ({
  TRASH_ID: 'trash',
  loadNote: state.loadNote,
  writeExportFile: state.writeExportFile
}));
vi.mock('$lib/stores/tree.svelte', () => ({
  tree: {
    get notesById() {
      return state.notes;
    },
    collectionsById: state.collections
  }
}));
vi.mock('$lib/notes-export/excalidraw', () => ({
  buildExcalidrawFile: vi.fn()
}));
vi.mock('$lib/note-exporters/pdf', () => ({ buildPdfNoteBytes: vi.fn() }));
import { exportVault } from './index';

beforeEach(() => {
  state.notes = {};
  state.loadNote.mockReset();
  state.writeExportFile.mockReset().mockResolvedValue(undefined);
});

function seed(id: string, kind: string, body = '', yrs_state: number[] = []) {
  const note = {
    tags: [],
    favourite: false,
    created: '2026-10-22T00:00:00Z',
    modified: '2026-10-22T00:00:00Z',
    id,
    note_kind: kind,
    title: 'Same title',
    body,
    yrs_state,
    parent_collection_id: null,
    trashed: false
  };
  state.notes[id] = note;
  state.loadNote.mockImplementation(async (id: string) => state.notes[id]);
}

describe('vault export additions', () => {
  it('writes readable Kanban plus a complete JSON companion, and Typst source without a compiler', async () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, {
      columns: [{ id: 'todo', label: 'To Do', order: 0 }],
      cards: [
        { id: 'one', label: 'Task', column: 'todo', order: 0, users: ['alice'] }
      ]
    });
    seed('board', 'kanban', '', Array.from(Y.encodeStateAsUpdate(doc)));
    seed('typst', 'plugin.com.mindstream.typst.document', '= Source\n');
    seed('second-typst', 'plugin.com.mindstream.typst.document', '');
    doc.destroy();
    const report = await exportVault('/exports');
    expect(report).toMatchObject({
      kanban_written: 1,
      typst_written: 2,
      errors: 0,
      skipped_unknown_kind: 0
    });
    const outputs = new Map(
      state.writeExportFile.mock.calls.map(([, name, bytes]) => [
        name,
        new TextDecoder().decode(bytes)
      ])
    );
    expect(outputs.get('Same title.md')).toContain('- [ ] Task');
    expect(JSON.parse(outputs.get('Same title.kanban.json')!)).toMatchObject({
      cards: [{ id: 'one', users: ['alice'] }]
    });
    expect(outputs.get('Same title.typ')).toBe('= Source\n');
    expect(outputs.get('Same title_2.typ')).toBe('');
  });

  it('reports damaged Kanban state as an error and continues with other notes', async () => {
    seed('broken', 'kanban', '', [1, 2, 3]);
    seed('typst', 'plugin.com.mindstream.typst.document', '= Good');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await exportVault('/exports');
    expect(report).toMatchObject({
      kanban_written: 0,
      typst_written: 1,
      errors: 1
    });
    log.mockRestore();
  });
});
