/**
 * Markdown *text* transforms for the raw-source editor.
 *
 * When the note is in Source (or Split with the source pane last used), the
 * shared toolbar and the hotkey bus dispatch the SAME command ids they use for
 * the WYSIWYG surface (`app.undo`, `editor.markdown.*` — see
 * `$lib/hotkeys/markdown-actions.ts`). Instead of running ProseMirror commands,
 * we mutate the CodeMirror document as plain markdown: Bold wraps the selection
 * in `**…**`, H1 prefixes the line with `# `, and so on. The result flows back
 * into the Yjs doc through NoteEditor's source→doc sync, so the WYSIWYG side
 * reflects it immediately.
 *
 * The transforms are split into a **pure** layer (string in → edit description
 * out) that is unit-tested without a live CodeMirror, and a thin `SOURCE_ACTIONS`
 * map that applies those edits to an `EditorView`. Undo/redo defer to
 * CodeMirror's own history so the source editor behaves like a normal text
 * editor.
 */

import type { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { APP_REDO_COMMAND, APP_UNDO_COMMAND } from '$lib/hotkeys/bus.svelte';

/** A minimal, CodeMirror-shaped description of a document edit. Kept free of
 *  any CodeMirror import so the pure transforms below are trivially testable. */
export interface SourceEdit {
  changes: { from: number; to: number; insert: string }[];
  /** New selection after the edit, in post-change document coordinates. */
  selection?: { anchor: number; head: number };
}

// -- Line helpers ------------------------------------------------------------

interface Line {
  start: number;
  end: number;
  text: string;
}

/** The line (newline-delimited) containing `pos`. */
function lineAt(doc: string, pos: number): Line {
  const start = doc.lastIndexOf('\n', pos - 1) + 1;
  let end = doc.indexOf('\n', pos);
  if (end === -1) end = doc.length;
  return { start, end, text: doc.slice(start, end) };
}

/** Every line the selection `[from, to]` overlaps, in document order. A caret
 *  (empty selection) yields exactly the line it sits on. */
function selectedLines(doc: string, from: number, to: number): Line[] {
  const first = lineAt(doc, from);
  const lines: Line[] = [first];
  let cursor = first.end;
  while (cursor < to) {
    const next = lineAt(doc, cursor + 1);
    lines.push(next);
    cursor = next.end;
  }
  return lines;
}

type PrefixKind = 'heading' | 'bullet' | 'ordered' | 'task';

/** Split a line into leading indent + the marker-free body, recognising the
 *  block prefixes we round-trip (ATX headings, bullets, task items, ordered).
 *  Task must be probed before bullet since `- [ ] x` also starts with `- `. */
function splitPrefix(line: string): {
  indent: string;
  kind: PrefixKind | null;
  body: string;
} {
  const m =
    /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)?(.*)$/.exec(line);
  const indent = m?.[1] ?? '';
  const marker = m?.[2];
  const body = m?.[3] ?? line;
  let kind: PrefixKind | null = null;
  if (marker) {
    if (/^#{1,6}\s+$/.test(marker)) kind = 'heading';
    else if (/^[-*+]\s+\[[ xX]\]\s+$/.test(marker)) kind = 'task';
    else if (/^\d+\.\s+$/.test(marker)) kind = 'ordered';
    else kind = 'bullet';
  }
  return { indent, kind, body };
}

/** Replace the block of lines `[from, to]` spans with `rebuild(...)` applied to
 *  each, joining on newline and selecting the rebuilt block. */
function rewriteLines(
  doc: string,
  from: number,
  to: number,
  rebuild: (lines: Line[]) => string[]
): SourceEdit {
  const lines = selectedLines(doc, from, to);
  const blockStart = lines[0].start;
  const blockEnd = lines[lines.length - 1].end;
  const insert = rebuild(lines).join('\n');
  return {
    changes: [{ from: blockStart, to: blockEnd, insert }],
    selection: { anchor: blockStart, head: blockStart + insert.length }
  };
}

// -- Pure transforms ---------------------------------------------------------

/**
 * Toggle an inline marker (`**`, `*`, `` ` ``) around the selection. Unwraps
 * when the selection is already wrapped (markers just inside OR just outside
 * the selection); otherwise wraps. An empty selection inserts the pair and
 * drops the caret between them so the user can type inside the mark.
 */
export function toggleInlineMarker(
  doc: string,
  from: number,
  to: number,
  marker: string
): SourceEdit {
  const mlen = marker.length;
  const sel = doc.slice(from, to);

  // Markers sitting just outside the selection → unwrap them.
  if (
    from >= mlen &&
    doc.slice(from - mlen, from) === marker &&
    doc.slice(to, to + mlen) === marker
  ) {
    return {
      changes: [
        { from: from - mlen, to: from, insert: '' },
        { from: to, to: to + mlen, insert: '' }
      ],
      selection: { anchor: from - mlen, head: to - mlen }
    };
  }

  // Markers inside the selection → unwrap.
  if (
    sel.length >= 2 * mlen &&
    sel.startsWith(marker) &&
    sel.endsWith(marker)
  ) {
    const inner = sel.slice(mlen, sel.length - mlen);
    return {
      changes: [{ from, to, insert: inner }],
      selection: { anchor: from, head: from + inner.length }
    };
  }

  // Otherwise wrap. Empty selection → caret lands between the markers.
  const insert = marker + sel + marker;
  return {
    changes: [{ from, to, insert }],
    selection: { anchor: from + mlen, head: to + mlen }
  };
}

/** Set the ATX heading level of every selected line (`level` 1–6), or strip the
 *  block marker back to a plain paragraph when `level` is 0. Existing block
 *  markers (heading/list) are replaced, never stacked. */
export function applyHeading(
  doc: string,
  from: number,
  to: number,
  level: number
): SourceEdit {
  const prefix = level === 0 ? '' : `${'#'.repeat(level)} `;
  return rewriteLines(doc, from, to, (lines) =>
    lines.map((l) => {
      const { indent, body } = splitPrefix(l.text);
      return indent + prefix + body;
    })
  );
}

/**
 * Toggle a list prefix (`bullet` → `- `, `ordered` → `1. `, `task` → `- [ ] `)
 * across the selected lines. If every line already carries the target kind the
 * whole block is unlisted; otherwise every line is unified to the target
 * (ordered lists are renumbered sequentially).
 */
export function toggleListPrefix(
  doc: string,
  from: number,
  to: number,
  kind: PrefixKind
): SourceEdit {
  const lines = selectedLines(doc, from, to);
  const allTarget = lines.every((l) => splitPrefix(l.text).kind === kind);
  let ordinal = 0;
  return rewriteLines(doc, from, to, () =>
    lines.map((l) => {
      const { indent, body } = splitPrefix(l.text);
      if (allTarget) return indent + body;
      ordinal += 1;
      const marker =
        kind === 'ordered' ? `${ordinal}. ` : kind === 'task' ? '- [ ] ' : '- ';
      return indent + marker + body;
    })
  );
}

/**
 * Insert a multi-line block snippet on its own line(s) below the caret's line.
 * `caretOffset` (relative to the start of the inserted snippet) positions the
 * caret inside the block — e.g. between the fences of a code block.
 */
export function insertBlock(
  doc: string,
  from: number,
  to: number,
  snippet: string,
  caretOffset: number
): SourceEdit {
  const line = lineAt(doc, to);
  const atBlankLine = line.text.trim() === '';
  // Drop onto the current line when it's empty; otherwise open a fresh line.
  const lead = atBlankLine ? '' : '\n';
  const insertPos = atBlankLine ? line.start : line.end;
  const insert = lead + snippet;
  const caret = insertPos + lead.length + caretOffset;
  return {
    changes: [{ from: insertPos, to: insertPos, insert }],
    selection: { anchor: caret, head: caret }
  };
}

// Block snippets. The `|` marks where the caret should land (stripped before
// insertion and translated into a caretOffset).
const CODE_SNIPPET = '```\n|\n```';
const MATH_SNIPPET = '$$\n|\n$$';
const MERMAID_SNIPPET = '```mermaid\n|\n```';
const IMAGE_SNIPPET = '![|]()';
const TABLE_SNIPPET = '| | |\n| --- | --- |\n| | |';

function blockInserter(template: string) {
  const caretOffset = template.indexOf('|');
  const snippet = template.replace('|', '');
  return (view: EditorView) =>
    applyEdit(view, (doc, from, to) =>
      insertBlock(
        doc,
        from,
        to,
        snippet,
        caretOffset < 0 ? snippet.length : caretOffset
      )
    );
}

// -- CodeMirror glue ---------------------------------------------------------

function applyEdit(
  view: EditorView,
  transform: (doc: string, from: number, to: number) => SourceEdit
): void {
  const { from, to } = view.state.selection.main;
  const edit = transform(view.state.doc.toString(), from, to);
  view.dispatch({ changes: edit.changes, selection: edit.selection });
  view.focus();
}

function inline(marker: string) {
  return (view: EditorView) =>
    applyEdit(view, (doc, from, to) =>
      toggleInlineMarker(doc, from, to, marker)
    );
}

function heading(level: number) {
  return (view: EditorView) =>
    applyEdit(view, (doc, from, to) => applyHeading(doc, from, to, level));
}

function list(kind: PrefixKind) {
  return (view: EditorView) =>
    applyEdit(view, (doc, from, to) => toggleListPrefix(doc, from, to, kind));
}

const doUndo = (view: EditorView) => {
  undo(view);
  view.focus();
};
const doRedo = (view: EditorView) => {
  redo(view);
  view.focus();
};

/**
 * Command id → source-editor action. Keys mirror `MARKDOWN_ACTIONS` so the same
 * toolbar buttons and hotkeys drive either surface; NoteEditor picks this table
 * when the active surface is the raw-source editor.
 */
export const SOURCE_ACTIONS: Record<string, (view: EditorView) => void> = {
  [APP_UNDO_COMMAND]: doUndo,
  [APP_REDO_COMMAND]: doRedo,
  'editor.markdown.undo': doUndo,
  'editor.markdown.redo': doRedo,
  'editor.markdown.bold': inline('**'),
  'editor.markdown.italic': inline('*'),
  'editor.markdown.paragraph': heading(0),
  'editor.markdown.h1': heading(1),
  'editor.markdown.h2': heading(2),
  'editor.markdown.h3': heading(3),
  'editor.markdown.h4': heading(4),
  'editor.markdown.h5': heading(5),
  'editor.markdown.h6': heading(6),
  'editor.markdown.bulletList': list('bullet'),
  'editor.markdown.orderedList': list('ordered'),
  'editor.markdown.taskList': list('task'),
  'editor.markdown.codeBlock': blockInserter(CODE_SNIPPET),
  'editor.markdown.imageBlock': blockInserter(IMAGE_SNIPPET),
  'editor.markdown.table': blockInserter(TABLE_SNIPPET),
  'editor.markdown.math': blockInserter(MATH_SNIPPET),
  'editor.markdown.mermaidDiagram': blockInserter(MERMAID_SNIPPET)
};
