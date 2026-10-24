import * as Y from 'yjs';
import {
  readBoardFromYDoc,
  seedDefaultBoard,
  type KanbanBoard,
  type KanbanCardData
} from '$lib/kanban/kanban-yjs';

export function readExportBoard(state: number[] | Uint8Array): KanbanBoard {
  const doc = new Y.Doc();
  try {
    if (state.length) Y.applyUpdate(doc, new Uint8Array(state));
    // Match the editor for boards that have never saved their default columns.
    seedDefaultBoard(doc);
    return readBoardFromYDoc(doc);
  } finally {
    doc.destroy();
  }
}

const HEADERS = [
  'Column',
  'Title',
  'Description',
  'Priority',
  'Progress',
  'Deadline',
  'Tags',
  'Users',
  'Linked note',
  'Linked note ID',
  'Order',
  'Card ID'
];

function orderedCards(board: KanbanBoard): KanbanCardData[] {
  const columns = new Map(
    board.columns.map((column) => [column.id, column.order])
  );
  return [...board.cards].sort(
    (a, b) =>
      (columns.get(a.column) ?? Infinity) -
        (columns.get(b.column) ?? Infinity) ||
      a.order - b.order ||
      a.id.localeCompare(b.id)
  );
}

export function boardRows(
  board: KanbanBoard,
  noteTitles: Record<string, string> = {}
): (string | number | Date)[][] {
  const columns = new Map(
    board.columns.map((column) => [column.id, column.label])
  );
  const labels = new Map(
    (board.labels ?? []).map((label) => [label.id, label.label])
  );
  return orderedCards(board).map((card) => [
    columns.get(card.column) ?? card.column,
    card.label,
    card.description ?? '',
    card.priority ?? '',
    card.progress ?? '',
    card.deadline && Number.isFinite(card.deadline.getTime())
      ? card.deadline
      : '',
    (card.tags ?? []).map((id) => labels.get(id) ?? id).join('; '),
    (card.users ?? []).join('; '),
    card.linkedNoteId
      ? (noteTitles[card.linkedNoteId] ?? card.linkedNoteId)
      : '',
    card.linkedNoteId ?? '',
    card.order,
    card.id
  ]);
}

// Quoting handles CSV syntax; the apostrophe stops spreadsheets executing user text.
function csvCell(value: string | number | Date): string {
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function boardCsv(
  board: KanbanBoard,
  noteTitles?: Record<string, string>
): string {
  return (
    '\uFEFF' +
    [HEADERS, ...boardRows(board, noteTitles)]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') +
    '\r\n'
  );
}

export async function boardXlsx(
  board: KanbanBoard,
  noteTitles?: Record<string, string>
): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const cards = workbook.addWorksheet('Cards');
  cards.addRow(HEADERS);
  for (const row of boardRows(board, noteTitles)) cards.addRow(row);
  cards.views = [{ state: 'frozen', ySplit: 1 }];
  cards.autoFilter = { from: 'A1', to: 'L1' };
  cards.getRow(1).font = { bold: true };
  cards.getColumn(6).numFmt = 'yyyy-mm-dd hh:mm';
  cards.columns.forEach((column, index) => {
    column.width = index === 2 ? 60 : 24;
  });
  cards.getColumn(3).alignment = { wrapText: true, vertical: 'top' };
  const columns = workbook.addWorksheet('Columns');
  columns.addRow(['ID', 'Title', 'Order', 'Collapsed']);
  for (const column of [...board.columns].sort((a, b) => a.order - b.order)) {
    columns.addRow([
      column.id,
      column.label,
      column.order,
      column.collapsed ?? false
    ]);
  }
  const labels = workbook.addWorksheet('Labels');
  labels.addRow(['ID', 'Label', 'Color', 'Order']);
  for (const label of board.labels ?? [])
    labels.addRow([label.id, label.label, label.color ?? '', label.order]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function line(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>#])/g, '\\$1');
}

export function boardMarkdown(
  board: KanbanBoard,
  includeFrontmatter = true
): string {
  const lines = includeFrontmatter
    ? ['---', 'kanban-plugin: board', '---', '']
    : [];
  const known = new Set(board.columns.map((column) => column.id));
  const columns = [...board.columns].sort((a, b) => a.order - b.order);
  if (board.cards.some((card) => !known.has(card.column)))
    columns.push({ id: '', label: 'Unassigned', order: Infinity });
  const labels = new Map(
    (board.labels ?? []).map((label) => [label.id, label.label])
  );
  for (const column of columns) {
    lines.push(`## ${line(column.label)}`, '');
    for (const card of orderedCards(board).filter((card) =>
      column.id ? card.column === column.id : !known.has(card.column)
    )) {
      lines.push(
        `- [${card.progress === 100 ? 'x' : ' '}] ${line(card.label)}`
      );
      if (card.description)
        lines.push(...card.description.split('\n').map((text) => `  ${text}`));
      const metadata = [
        card.deadline && Number.isFinite(card.deadline.getTime())
          ? `Due: ${card.deadline.toISOString()}`
          : '',
        card.priority !== undefined ? `Priority: ${card.priority}` : '',
        card.progress !== undefined ? `Progress: ${card.progress}` : '',
        card.tags?.length
          ? `Tags: ${card.tags.map((id) => labels.get(id) ?? id).join('; ')}`
          : '',
        card.users?.length ? `Users: ${card.users.join('; ')}` : '',
        card.linkedNoteId ? `Linked note: ${card.linkedNoteId}` : ''
      ].filter(Boolean);
      for (const text of metadata) lines.push(`  - ${line(text)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
