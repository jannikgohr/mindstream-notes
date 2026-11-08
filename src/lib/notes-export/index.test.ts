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
const pdf = vi.hoisted(() => ({
  build: vi.fn(),
  overlays: vi.fn()
}));
vi.mock('$lib/note-exporters/pdf', () => ({
  buildPdfNoteBytes: pdf.build,
  pdfNoteHasOverlays: pdf.overlays
}));
vi.mock('$lib/settings/i18n.svelte', () => ({ tUi: (key: string) => key }));
const download = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/file-export', () => ({ downloadBlob: download }));
const native = vi.hoisted(() => ({
  begin: vi.fn(),
  types: vi.fn(),
  session: {
    write: vi.fn(),
    copyAsset: vi.fn(),
    finish: vi.fn(),
    abort: vi.fn()
  }
}));
vi.mock('$lib/api/export-session', () => ({
  ExportSession: { begin: native.begin },
  exportAssetTypes: native.types
}));
import {
  downloadVaultExport,
  exportVault,
  exportVaultToFolder,
  saveVaultArchive,
  streamVaultExport
} from './index';

beforeEach(() => {
  state.notes = {};
  state.loadNote.mockReset();
  state.writeExportFile.mockReset().mockResolvedValue(undefined);
  state.fetchDrawingAsset.mockReset();
  download.mockReset();
  pdf.build.mockReset().mockResolvedValue(new Uint8Array([37, 80]));
  pdf.overlays.mockReset().mockReturnValue(false);
  native.begin.mockReset().mockResolvedValue(native.session);
  native.types.mockReset().mockResolvedValue(new Map());
  native.session.write.mockReset().mockResolvedValue(undefined);
  native.session.copyAsset.mockReset().mockResolvedValue(undefined);
  native.session.finish.mockReset().mockResolvedValue(true);
  native.session.abort.mockReset().mockResolvedValue(undefined);
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
});

describe('native export sessions', () => {
  const written = () =>
    native.session.write.mock.calls.map(([path]) => path as string);

  it('builds the ZIP natively, then asks where to save it', async () => {
    seed('typst', 'plugin.com.mindstream.typst.document', '= Good');
    const report = await saveVaultArchive();
    expect(report?.typst_written).toBe(1);
    expect(native.begin).toHaveBeenCalledWith({ kind: 'archive' });
    expect(written()).toEqual(['Same title.typ']);
    const [save] = native.session.finish.mock.calls[0];
    expect(save).toMatchObject({
      dialogTitle: 'data.exportVault.saveDialog.title',
      filterName: 'data.exportVault.saveDialog.filter',
      extensions: ['zip']
    });
    expect(save.suggestedName).toMatch(
      /^mindstream-notes-\d{4}-\d{2}-\d{2}\.zip$/
    );
    expect(download).not.toHaveBeenCalled();
  });

  it('returns null when the save dialog is cancelled', async () => {
    native.session.finish.mockResolvedValue(false);
    expect(await saveVaultArchive()).toBeNull();
  });

  it('drops the staged ZIP when building it fails', async () => {
    seed('typst', 'plugin.com.mindstream.typst.document', '= Good');
    state.notes = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('tree unavailable');
        }
      }
    );
    await expect(saveVaultArchive()).rejects.toThrow('tree unavailable');
    expect(native.session.abort).toHaveBeenCalledOnce();
    expect(native.session.finish).not.toHaveBeenCalled();
  });

  it('propagates a failed save', async () => {
    native.session.finish.mockRejectedValue(new Error('provider write failed'));
    await expect(saveVaultArchive()).rejects.toThrow('provider write failed');
  });

  it('writes a folder export through a folder session', async () => {
    seed('typst', 'plugin.com.mindstream.typst.document', '= Good');
    const report = await exportVaultToFolder('/export');
    expect(report.typst_written).toBe(1);
    expect(native.begin).toHaveBeenCalledWith({
      kind: 'folder',
      root: '/export'
    });
    expect(native.session.finish).toHaveBeenCalledWith();
  });

  it('copies attachments natively instead of loading them', async () => {
    seed(
      'image',
      'markdown',
      '![a](asset:mindstream/asset_one) ![b](asset:mindstream/asset_gone)'
    );
    native.types.mockResolvedValue(new Map([['asset_one', 'image/png']]));
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await exportVaultToFolder('/export');
      expect(report).toMatchObject({ assets_written: 1, errors: 1 });
    } finally {
      log.mockRestore();
    }
    expect(state.fetchDrawingAsset).not.toHaveBeenCalled();
    expect(native.types).toHaveBeenCalledWith(['asset_one', 'asset_gone']);
    expect(native.session.copyAsset).toHaveBeenCalledWith(
      '_assets/asset_one.png',
      'asset_one',
      'image/png'
    );
    const body = new TextDecoder().decode(
      native.session.write.mock.calls[0][1] as Uint8Array
    );
    expect(body).toContain('_assets/asset_one.png');
    // The missing attachment keeps its original link.
    expect(body).toContain('asset:mindstream/asset_gone');
  });

  it('copies a PDF with nothing drawn on it, and renders one that has', async () => {
    seed('plain', 'pdf', JSON.stringify({ pdfAssetId: 'asset_pdf' }));
    await exportVaultToFolder('/export');
    expect(native.session.copyAsset).toHaveBeenCalledWith(
      'Same title.pdf',
      'asset_pdf',
      'application/pdf'
    );
    expect(pdf.build).not.toHaveBeenCalled();

    native.session.copyAsset.mockClear();
    pdf.overlays.mockReturnValue(true);
    await exportVaultToFolder('/export');
    expect(native.session.copyAsset).not.toHaveBeenCalled();
    expect(pdf.build).toHaveBeenCalledWith('plain');
    expect(written()).toContain('Same title.pdf');
  });
});

describe('streamed browser export', () => {
  const file = () => ({
    chunks: [] as Uint8Array[],
    write: vi.fn(async function (this: { chunks: Uint8Array[] }, chunk) {
      this.chunks.push(chunk.slice());
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {})
  });

  it('streams the vault zip into the picked file and closes it', async () => {
    seed('typst', 'plugin.com.mindstream.typst.document', '= Good');
    const target = file();
    const report = await streamVaultExport(target);
    expect(report.typst_written).toBe(1);
    expect(target.close).toHaveBeenCalledOnce();
    expect(target.abort).not.toHaveBeenCalled();
    const bytes = new Uint8Array(
      target.chunks.reduce((n, c) => n + c.length, 0)
    );
    let offset = 0;
    for (const chunk of target.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const { unzipSync } = await import('fflate');
    expect(new TextDecoder().decode(unzipSync(bytes)['Same title.typ'])).toBe(
      '= Good'
    );
    expect(download).not.toHaveBeenCalled();
  });

  it('discards the partial file when writing fails', async () => {
    seed('typst', 'plugin.com.mindstream.typst.document', '= Good');
    const target = file();
    target.close.mockRejectedValue(new Error('disk full'));
    await expect(streamVaultExport(target)).rejects.toThrow('disk full');
    expect(target.abort).toHaveBeenCalledOnce();
  });
});
