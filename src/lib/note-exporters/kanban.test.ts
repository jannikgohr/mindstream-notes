import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import ExcelJS from 'exceljs';
import { strFromU8 } from 'fflate';
import { writeBoardToYDoc, type KanbanBoard } from '$lib/kanban/kanban-yjs';
import { kanbanExporters } from './kanban';

const { loadNote, saveFileExport, fetchDrawingAsset } = vi.hoisted(() => ({
  loadNote: vi.fn(),
  saveFileExport: vi.fn(),
  fetchDrawingAsset: vi.fn()
}));
vi.mock('$lib/api', () => ({ loadNote }));
vi.mock('$lib/api/file-export', () => ({ saveFileExport }));
vi.mock('$lib/api/assets', () => ({ fetchDrawingAsset }));
vi.mock('$lib/stores/tree.svelte', () => ({
  tree: { notesById: { linked: { id: 'linked', title: 'Related note' } } }
}));

const board: KanbanBoard = {
  columns: [{ id: 'todo', label: 'To do', order: 0 }],
  cards: [
    {
      id: 'card-1',
      label: 'Review',
      column: 'todo',
      order: 0,
      description: '![Chart](asset:mindstream/chart)',
      linkedNoteId: 'linked'
    }
  ],
  labels: []
};

beforeEach(() => {
  vi.resetAllMocks();
  const doc = new Y.Doc();
  writeBoardToYDoc(doc, board);
  loadNote.mockResolvedValue({
    id: 'board',
    title: 'Board: review',
    note_kind: 'kanban',
    yrs_state: Y.encodeStateAsUpdate(doc)
  });
  doc.destroy();
  saveFileExport.mockResolvedValue(true);
  fetchDrawingAsset.mockResolvedValue({
    bytes: [1, 2, 3],
    mime_type: 'image/png'
  });
});

describe('Kanban note exporters', () => {
  it.each(kanbanExporters)(
    'exports persisted board data as $label',
    async (exporter) => {
      await exporter.run('board');
      expect(loadNote).toHaveBeenCalledWith('board');
      expect(saveFileExport).toHaveBeenCalledOnce();
      const saved = saveFileExport.mock.calls[0][0];
      const format = exporter.id.split('.')[1];
      expect(saved.suggestedName).toBe(`Board review.${format}`);
      expect(saved.extensions).toEqual([format]);
      if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(saved.bytes);
        expect(workbook.getWorksheet('Cards')!.getCell('I2').value).toBe(
          'Related note'
        );
        expect(workbook.getWorksheet('Cards')!.getCell('L2').value).toBe(
          'card-1'
        );
      } else if (format === 'json') {
        expect(JSON.parse(strFromU8(saved.bytes))).toEqual(board);
      } else if (format === 'csv') {
        expect(strFromU8(saved.bytes)).toContain('"Related note","linked"');
        expect(strFromU8(saved.bytes)).toContain('asset:mindstream/chart');
      } else {
        expect(strFromU8(saved.bytes)).toContain('- [ ] Review');
        expect(strFromU8(saved.bytes)).toContain('data:image/png;base64,AQID');
        expect(fetchDrawingAsset).toHaveBeenCalledWith('chart');
      }
    }
  );

  it.each(kanbanExporters)(
    'rejects other note kinds for $label',
    async (exporter) => {
      loadNote.mockResolvedValue({ note_kind: 'markdown' });
      await expect(exporter.run('board')).rejects.toThrow(
        'only available for Kanban boards'
      );
      expect(saveFileExport).not.toHaveBeenCalled();
    }
  );

  it('does not save corrupt board state as an empty board', async () => {
    loadNote.mockResolvedValue({ note_kind: 'kanban', yrs_state: [1, 2, 3] });
    await expect(kanbanExporters[0].run('board')).rejects.toThrow();
    expect(saveFileExport).not.toHaveBeenCalled();
  });
});
