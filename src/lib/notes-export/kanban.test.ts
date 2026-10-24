import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import ExcelJS from 'exceljs';
import { writeBoardToYDoc, type KanbanBoard } from '$lib/kanban/kanban-yjs';
import {
  boardCsv,
  boardMarkdown,
  boardRows,
  boardXlsx,
  readExportBoard
} from './kanban';

const board: KanbanBoard = {
  columns: [
    { id: 'done', label: 'Done', order: 1 },
    { id: 'todo', label: 'To Do', order: 0, collapsed: true }
  ],
  labels: [{ id: 'tag', label: 'Urgent', color: '#f00', order: 0 }],
  cards: [
    { id: 'last', label: 'Finished', column: 'done', order: 0 },
    {
      id: 'first',
      label: '=HYPERLINK("bad")',
      column: 'todo',
      order: 0,
      description: 'Line 1, "quoted"\nLine 2',
      priority: 0,
      progress: 50,
      deadline: new Date('2026-10-22T09:00:00Z'),
      tags: ['tag'],
      users: ['alice'],
      linkedNoteId: 'linked'
    },
    { id: 'orphan', label: 'Orphan', column: 'missing', order: 1 }
  ]
};

describe('Kanban export', () => {
  it('orders equal-position cards by ID and keeps unknown metadata readable', () => {
    const minimal: KanbanBoard = {
      columns: [{ id: 'todo', label: '# To do\nnext', order: 0 }],
      cards: [
        { id: 'z', label: 'Later', column: 'todo', order: 2 },
        { id: 'b', label: 'Second', column: 'todo', order: 1 },
        {
          id: 'a',
          label: '*Complete*',
          column: 'todo',
          order: 1,
          progress: 100,
          deadline: new Date('invalid'),
          tags: ['missing'],
          users: ['alice'],
          linkedNoteId: 'missing-note'
        },
        { id: 'orphan', label: 'Unassigned', column: 'gone', order: 0 }
      ]
    };
    const rows = boardRows(minimal);
    expect(rows.map((row) => row[11])).toEqual(['a', 'b', 'z', 'orphan']);
    expect(rows[0].slice(4, 10)).toEqual([
      100,
      '',
      'missing',
      'alice',
      'missing-note',
      'missing-note'
    ]);
    expect(rows[3][0]).toBe('gone');
    const markdown = boardMarkdown(minimal, false);
    expect(markdown).not.toContain('kanban-plugin');
    expect(markdown).toContain('## \\# To do next');
    expect(markdown).toContain('- [x] \\*Complete\\*');
    expect(markdown).toContain('Tags: missing');
    expect(markdown).not.toContain('Due:');
  });

  it('writes empty metadata sheets when a board has no labels', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await boardXlsx({ columns: [], cards: [] })) as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0]
    );
    expect(workbook.getWorksheet('Labels')!.rowCount).toBe(1);
    expect(workbook.getWorksheet('Cards')!.rowCount).toBe(1);
  });

  it.each(['=1', '+1', '-1', '@sum(A1)', ' \t=1'])(
    'keeps formula-like text %s literal in CSV',
    (label) => {
      const csv = boardCsv({
        columns: [],
        cards: [{ id: 'card', column: 'missing', label, order: 0 }]
      });
      expect(csv).toContain(`"'${label}"`);
    }
  );
  it('reads persisted state without dropping dates, IDs or metadata', () => {
    const doc = new Y.Doc();
    writeBoardToYDoc(doc, board);
    const exported = readExportBoard(Y.encodeStateAsUpdate(doc));
    expect(exported.cards.find((card) => card.id === 'first')).toMatchObject({
      deadline: board.cards[1].deadline,
      tags: ['tag'],
      linkedNoteId: 'linked'
    });
    doc.destroy();
    expect(readExportBoard([]).cards).toEqual([]);
    expect(readExportBoard([]).columns.map((column) => column.id)).toEqual([
      'todo',
      'doing',
      'done'
    ]);
    expect(() => readExportBoard([1, 2, 3])).toThrow();
  });

  it('escapes CSV text, preserves multiline descriptions, and protects formula cells', () => {
    const csv = boardCsv(board, { linked: 'Linked title' });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('"Line 1, ""quoted""\nLine 2"');
    expect(csv).toContain('"2026-10-22T09:00:00.000Z"');
    expect(csv).toContain('"Urgent","alice","Linked title","linked"');
    expect(boardRows(board)[0][0]).toBe('To Do');
  });

  it('writes a real Excel workbook with typed dates, literal formula-like text, and metadata sheets', async () => {
    const bytes = await boardXlsx(board);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]
    );
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Cards',
      'Columns',
      'Labels'
    ]);
    const cards = workbook.getWorksheet('Cards')!;
    expect(cards.getCell('B2').value).toBe('=HYPERLINK("bad")');
    expect(cards.getCell('D2').value).toBe(0);
    expect(cards.getCell('F2').value).toEqual(new Date('2026-10-22T09:00:00Z'));
    expect(cards.getCell('C2').value).toBe(board.cards[1].description);
    expect(cards.rowCount).toBe(4);
    expect(workbook.getWorksheet('Labels')!.getCell('B2').value).toBe('Urgent');
  });

  it('writes column headings, task cards, metadata and unassigned cards as Markdown', () => {
    const markdown = boardMarkdown(board);
    expect(markdown).toContain('kanban-plugin: board');
    expect(markdown.indexOf('## To Do')).toBeLessThan(
      markdown.indexOf('## Done')
    );
    expect(markdown).toContain('Priority: 0');
    expect(markdown).toContain('Tags: Urgent');
    expect(markdown).toContain('## Unassigned\n\n- [ ] Orphan');
  });
});
