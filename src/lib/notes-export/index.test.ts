import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { writeBoardToYDoc } from '$lib/kanban/kanban-yjs';

const state = vi.hoisted(() => ({
  notes: {} as Record<string, Record<string, unknown>>,
  collections: {},
  loadNote: vi.fn(),
  writeExportFile: vi.fn(),
  fetchDrawingAsset: vi.fn()
}));
vi.mock('$lib/api', () => ({
  TRASH_ID: 'trash',
  loadNote: state.loadNote,
  writeExportFile: state.writeExportFile,
  fetchDrawingAsset: state.fetchDrawingAsset
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
const download = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/file-export', () => ({
  downloadBlob: download,
  saveFileExport: save
}));
import { downloadVaultExport, saveVaultExport, exportVault } from './index';

beforeEach(() => {
  state.notes = {};
  state.loadNote.mockReset();
  state.writeExportFile.mockReset().mockResolvedValue(undefined);
  state.fetchDrawingAsset.mockReset();
  download.mockReset();
  save.mockReset().mockResolvedValue(true);
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
  it('reports an attachment write failure and continues exporting other notes', async () => {
    seed('image', 'markdown', '![image](asset:mindstream/asset_one)');
    seed('source', 'plugin.com.mindstream.typst.document', '= Kept');
    state.fetchDrawingAsset.mockResolvedValue({
      mime_type: 'image/png',
      bytes: [1, 2, 3]
    });
    state.writeExportFile.mockImplementation(async (path: string) => {
      if (path.startsWith('_assets/'))
        throw new Error('The export is too large for a zip file');
    });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await exportVault(state.writeExportFile);
      expect(report).toMatchObject({
        markdown_written: 1,
        typst_written: 1,
        assets_written: 0,
        errors: 1
      });
      expect(state.writeExportFile.mock.calls.map(([path]) => path)).toEqual([
        '_assets/asset_one.png',
        'Same title.md',
        'Same title.typ'
      ]);
      expect(
        new TextDecoder().decode(state.writeExportFile.mock.calls[1][1])
      ).toContain('![image](asset:mindstream/asset_one)');
    } finally {
      log.mockRestore();
    }
  });

  it('preserves the original URL when an attachment cannot be read', async () => {
    seed('image', 'markdown', '![image](asset:mindstream/asset_missing)');
    state.fetchDrawingAsset.mockRejectedValue(new Error('Asset not found'));
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await exportVault(state.writeExportFile);
      expect(report).toMatchObject({
        markdown_written: 1,
        assets_written: 0,
        errors: 1
      });
      const [[path, bytes]] = state.writeExportFile.mock.calls;
      expect(path).toBe('Same title.md');
      expect(new TextDecoder().decode(bytes)).toContain(
        '![image](asset:mindstream/asset_missing)'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('writes readable Kanban plus a complete JSON companion, and Typst source without a compiler', async () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, {
      columns: [{ id: 'todo', label: 'To Do', order: 0 }],
      cards: [
        {
          id: 'one',
          label: 'Task',
          column: 'todo',
          order: 0,
          users: ['alice']
        }
      ]
    });
    seed('board', 'kanban', '', Array.from(Y.encodeStateAsUpdate(doc)));
    seed('typst', 'plugin.com.mindstream.typst.document', '= Source\n');
    seed('second-typst', 'plugin.com.mindstream.typst.document', '');
    doc.destroy();
    const report = await exportVault(state.writeExportFile);
    expect(report).toMatchObject({
      kanban_written: 1,
      typst_written: 2,
      errors: 0,
      skipped_unknown_kind: 0
    });
    const outputs = new Map(
      state.writeExportFile.mock.calls.map(([name, bytes]) => [
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
    const report = await exportVault(state.writeExportFile);
    expect(report).toMatchObject({
      kanban_written: 0,
      typst_written: 1,
      errors: 1
    });
    log.mockRestore();
  });

  it('hands a browser the whole vault as one dated zip', async () => {
    seed('typst', 'plugin.com.mindstream.typst.document', '= Good');
    const report = await downloadVaultExport();
    expect(report.typst_written).toBe(1);
    expect(state.writeExportFile).not.toHaveBeenCalled();
    const [blob, name] = download.mock.calls[0] as [Blob, string];
    expect(blob.type).toBe('application/zip');
    expect(name).toMatch(/^mindstream-notes-\d{4}-\d{2}-\d{2}\.zip$/);
  });
  it('saves a portable ZIP through the native document picker', async () => {
    seed('typst', 'plugin.com.mindstream.typst.document', '= Good');
    const report = await saveVaultExport();
    expect(report?.typst_written).toBe(1);
    const input = save.mock.calls[0][0];
    expect(input).toMatchObject({
      mime: 'application/zip',
      extensions: ['zip']
    });
    const { unzipSync } = await import('fflate');
    const entries = unzipSync(input.bytes);
    expect(new TextDecoder().decode(entries['Same title.typ'])).toBe('= Good');
    expect(download).not.toHaveBeenCalled();
  });

  it('returns null when the native ZIP picker is cancelled', async () => {
    save.mockResolvedValue(false);
    expect(await saveVaultExport()).toBeNull();
  });

  it('propagates native ZIP save errors', async () => {
    save.mockRejectedValue(new Error('provider write failed'));
    await expect(saveVaultExport()).rejects.toThrow('provider write failed');
  });
});
