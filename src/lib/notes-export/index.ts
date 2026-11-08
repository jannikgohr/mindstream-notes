/**
 * Vault export driver — walks the file tree and writes one file per
 * note to disk, preserving folder hierarchy.
 *
 *   markdown → `.md` with YAML frontmatter + asset bundling
 *   freeform → `.excalidraw` JSON
 *   pdf      → annotated `.pdf`
 *   kanban   → `.md` plus a `.kanban.json` companion
 *   typst    → `.typ` source, without requiring the plugin or compiler
 *   ink      → `.pdf` (one page per ink page, strokes rendered as vector polylines)
 *
 * Every file goes through an `ExportWriter`. The app writes through a native
 * export session, into the chosen folder or a ZIP, and copies stored assets
 * natively through an `AssetCopier`, so large files never cross IPC whole. A
 * browser fills a zip download instead. Both refuse a path that would leave
 * the export root, so user-supplied titles can't escape it.
 */

import * as api from '$lib/api';
import { TRASH_ID } from '$lib/api';
import type { Note, NoteSummary, Collection } from '$lib/api';
import { pdfAssetIdFromBody } from '$lib/pdf/viewer-helpers';
import { tree } from '$lib/stores/tree.svelte';
import { buildExcalidrawFile } from './excalidraw';
import { buildPdfNoteBytes, pdfNoteHasOverlays } from '$lib/note-exporters/pdf';
import { buildInkPdf } from './ink-pdf';
import {
  extractAssetIds,
  renderMarkdownFile,
  rewriteAssetUrls
} from './markdown';
import { dedupeAgainst, sanitizeName } from './sanitize';
import { readExportBoard, boardMarkdown } from './kanban';
import { downloadBlob } from '$lib/api/file-export';
import { ExportSession, exportAssetTypes } from '$lib/api/export-session';
import { tUi } from '$lib/settings/i18n.svelte';
import { createExportZip } from './zip';

const ASSET_SUBDIR = '_assets';

/** Stores one exported file at a path relative to the export root. */
export type ExportWriter = (
  relativePath: string,
  bytes: Uint8Array
) => Promise<void>;

/**
 * Copies stored assets into the export without loading their bytes into the
 * webview. Without one, assets are fetched and passed to the writer.
 */
export interface AssetCopier {
  /** MIME types by asset id. Ids that no longer exist are left out. */
  types(ids: string[]): Promise<Map<string, string>>;
  copy(path: string, assetId: string, mimeType?: string): Promise<void>;
}

export interface ExportReport {
  /** `.md` files written (note_kind = 'markdown'). */
  markdown_written: number;
  /** `.excalidraw` files written (note_kind = 'freeform'). */
  freeform_written: number;
  /** `.pdf` files written (note_kind = 'pdf'). */
  pdf_written: number;
  /** `.pdf` files written for ink notes (note_kind = 'ink'). */
  ink_written: number;
  kanban_written: number;
  typst_written: number;
  folders_written: number;
  /** Image / blob files copied into the per-folder `_assets/` subdir. */
  assets_written: number;
  skipped_trashed: number;
  skipped_unknown_kind: number;
  errors: number;
}

/** Export the vault into one zip download, for a browser. */
export async function downloadVaultExport(): Promise<ExportReport> {
  const zip = createExportZip();
  const report = await exportVault(zip.write);
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(zip.finish(), `mindstream-notes-${date}.zip`);
  return report;
}

function nativeAssets(session: ExportSession): AssetCopier {
  return { types: exportAssetTypes, copy: session.copyAsset };
}

/** Export into a folder the user picked, through a native session. */
export async function exportVaultToFolder(root: string): Promise<ExportReport> {
  const session = await ExportSession.begin({ kind: 'folder', root });
  try {
    const report = await exportVault(session.write, nativeAssets(session));
    await session.finish();
    return report;
  } catch (err) {
    await session.abort();
    throw err;
  }
}

/**
 * Build the export as a ZIP natively, then save it where the user picks.
 * Works with Android's document picker, which offers no folders to write
 * into. Resolves null when the user cancels the save dialog.
 */
export async function saveVaultArchive(): Promise<ExportReport | null> {
  const session = await ExportSession.begin({ kind: 'archive' });
  let report: ExportReport;
  try {
    report = await exportVault(session.write, nativeAssets(session));
  } catch (err) {
    await session.abort();
    throw err;
  }
  const saved = await session.finish({
    suggestedName: `mindstream-notes-${new Date().toISOString().slice(0, 10)}.zip`,
    dialogTitle: tUi('data.exportVault.saveDialog.title'),
    filterName: tUi('data.exportVault.saveDialog.filter'),
    extensions: ['zip']
  });
  return saved ? report : null;
}

export async function exportVault(
  write: ExportWriter,
  assets?: AssetCopier
): Promise<ExportReport> {
  const report: ExportReport = {
    markdown_written: 0,
    freeform_written: 0,
    pdf_written: 0,
    ink_written: 0,
    kanban_written: 0,
    typst_written: 0,
    folders_written: 0,
    assets_written: 0,
    skipped_trashed: 0,
    skipped_unknown_kind: 0,
    errors: 0
  };

  // Build the folder-id → relative-path map first so notes can look
  // up their parent in O(1). Collections under the special `trash`
  // collection are excluded entirely — anything that's been trashed
  // is treated as deleted from the user's POV.
  const folderPath = computeFolderPaths();
  report.folders_written = folderPath.size;

  // Per-directory dedup state. Keys are relative folder paths
  // (e.g. "Work/Sprint planning"); values are the file basenames
  // already used in that directory. `_assets/` lives one level deeper
  // and gets its own bucket.
  const takenByDir = new Map<string, Set<string>>();
  const takenFor = (dir: string): Set<string> => {
    let s = takenByDir.get(dir);
    if (!s) {
      s = new Set<string>();
      takenByDir.set(dir, s);
    }
    return s;
  };

  for (const summary of Object.values(tree.notesById)) {
    if (summary.trashed) {
      report.skipped_trashed++;
      continue;
    }
    if (summary.parent_collection_id === TRASH_ID) {
      report.skipped_trashed++;
      continue;
    }
    const parentDir =
      summary.parent_collection_id === null
        ? ''
        : folderPath.get(summary.parent_collection_id);
    if (parentDir === undefined) {
      // Parent resolved to nothing — it's a descendant of `trash` or
      // the collection got concurrently deleted. Skip.
      report.skipped_trashed++;
      continue;
    }
    try {
      const written = await exportNote(
        write,
        assets,
        summary,
        parentDir,
        takenFor
      );
      report.assets_written += written.assets_written;
      report.errors += written.errors ?? 0;
      switch (written.kind) {
        case 'markdown':
          report.markdown_written++;
          break;
        case 'freeform':
          report.freeform_written++;
          break;
        case 'pdf':
          report.pdf_written++;
          break;
        case 'ink':
          report.ink_written++;
          break;
        case 'kanban':
          report.kanban_written++;
          break;
        case 'typst':
          report.typst_written++;
          break;
        case 'unknown':
          // Helper logged a warning and wrote nothing; surface it in
          // the report under the existing "skipped unknown kind"
          // bucket instead of double-counting it as a written note.
          report.skipped_unknown_kind++;
          break;
      }
    } catch (err) {
      console.error('[notes-export] note failed', summary.id, err);
      report.errors++;
    }
  }

  return report;
}

/**
 * Walk the collections tree breadth-first, sanitising + deduping
 * names at each level. Returns a flat map from collection id to its
 * relative path inside the export root.
 *
 * Trashed folders and anything beneath them are deliberately omitted
 * from the map — the export skips them.
 */
function computeFolderPaths(): Map<string, string> {
  const out = new Map<string, string>();
  // Group children by parent for fast lookup.
  const childrenOf = new Map<string | null, Collection[]>();
  for (const c of Object.values(tree.collectionsById)) {
    if (c.id === TRASH_ID) continue;
    const parent = c.parent_collection_id ?? null;
    if (parent === TRASH_ID) continue; // direct child of trash → skip subtree
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(c);
    childrenOf.set(parent, bucket);
  }

  // BFS from the root level (parent = null). Tracks per-directory
  // dedup so siblings with the same sanitised name get `_2`, `_3`
  // suffixes consistently.
  const takenForParent = new Map<string, Set<string>>();
  const queue: Array<{ collection: Collection; parentPath: string }> = [];
  for (const c of childrenOf.get(null) ?? []) {
    queue.push({ collection: c, parentPath: '' });
  }
  while (queue.length > 0) {
    const { collection, parentPath } = queue.shift()!;
    let taken = takenForParent.get(parentPath);
    if (!taken) {
      taken = new Set<string>();
      takenForParent.set(parentPath, taken);
    }
    const folderName = dedupeAgainst(taken, sanitizeName(collection.name));
    const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
    out.set(collection.id, fullPath);
    for (const child of childrenOf.get(collection.id) ?? []) {
      queue.push({ collection: child, parentPath: fullPath });
    }
  }
  return out;
}

interface NoteWriteSummary {
  /** Kind that was actually handled (mirrors the loaded `note.note_kind`,
   *  which can lag the cached `summary.note_kind` if the tree is stale).
   *  The outer loop reads this to bump the right per-kind counter. */
  kind:
    | 'markdown'
    | 'freeform'
    | 'pdf'
    | 'ink'
    | 'kanban'
    | 'typst'
    | 'unknown';
  assets_written: number;
  errors?: number;
}

/** Per-helper return: the helpers don't carry the kind themselves —
 *  exportNote adds it from the switch arm above. */
interface AssetWriteSummary {
  assets_written: number;
  errors?: number;
}

async function exportNote(
  write: ExportWriter,
  assets: AssetCopier | undefined,
  summary: NoteSummary,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<NoteWriteSummary> {
  const note = await api.loadNote(summary.id);
  switch (note.note_kind) {
    case 'markdown': {
      const written = await exportMarkdown(
        write,
        assets,
        note,
        parentDir,
        takenFor
      );
      return { kind: 'markdown', ...written };
    }
    case 'freeform': {
      const written = await exportFreeform(write, note, parentDir, takenFor);
      return { kind: 'freeform', assets_written: written.assets_written };
    }
    case 'pdf': {
      const written = await exportPdf(write, assets, note, parentDir, takenFor);
      return { kind: 'pdf', assets_written: written.assets_written };
    }
    case 'ink': {
      const written = await exportInk(write, note, parentDir, takenFor);
      return { kind: 'ink', assets_written: written.assets_written };
    }
    case 'kanban': {
      const board = readExportBoard(note.yrs_state);
      const name = sanitizeName(note.title);
      // Bundle description assets using the Markdown export path. Keep JSON
      // alongside it so IDs, ordering, labels and card metadata survive too.
      const written = await exportMarkdown(
        write,
        assets,
        { ...note, body: boardMarkdown(board, false) },
        parentDir,
        takenFor
      );
      await write(
        joinRel(
          parentDir,
          dedupeAgainst(takenFor(parentDir), `${name}.kanban.json`)
        ),
        new TextEncoder().encode(JSON.stringify(board, null, 2))
      );
      return { kind: 'kanban', ...written };
    }
    case 'plugin.com.mindstream.typst.document': {
      const basename = dedupeAgainst(
        takenFor(parentDir),
        `${sanitizeName(note.title)}.typ`
      );
      await write(
        joinRel(parentDir, basename),
        new TextEncoder().encode(note.body)
      );
      return { kind: 'typst', assets_written: 0 };
    }
    default:
      // Unknown kind — count it but don't fail the whole export.
      console.warn(
        '[notes-export] unknown note kind, skipping',
        note.note_kind
      );
      return { kind: 'unknown', assets_written: 0 };
  }
}

async function exportMarkdown(
  write: ExportWriter,
  assets: AssetCopier | undefined,
  note: Note,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<AssetWriteSummary> {
  // 1. Resolve a per-folder filename for the markdown file.
  const fileBasename = dedupeAgainst(
    takenFor(parentDir),
    `${sanitizeName(note.title)}.md`
  );
  // 2. Find every asset referenced in the body and fetch its bytes.
  const ids = extractAssetIds(note.body);
  const assetSubdir = parentDir ? `${parentDir}/${ASSET_SUBDIR}` : ASSET_SUBDIR;
  const filenameById = new Map<string, string>();
  let assetsWritten = 0;
  let errors = 0;
  let types = new Map<string, string>();
  if (assets && ids.length > 0) {
    try {
      types = await assets.types(ids);
    } catch (err) {
      // Every asset below then fails on its own and is counted as an error.
      console.warn('[notes-export] could not look up assets', note.id, err);
    }
  }
  for (const id of ids) {
    try {
      if (assets) {
        const mime = types.get(id);
        if (mime === undefined) throw new Error(`Asset not found: ${id}`);
        const assetFilename = dedupeAgainst(
          takenFor(assetSubdir),
          `${id}${extensionForMime(mime)}`
        );
        await assets.copy(joinRel(assetSubdir, assetFilename), id, mime);
        filenameById.set(id, assetFilename);
        assetsWritten++;
        continue;
      }
      const asset = await api.fetchDrawingAsset(id);
      const ext = extensionForMime(asset.mime_type);
      const assetFilename = dedupeAgainst(takenFor(assetSubdir), `${id}${ext}`);
      await write(
        joinRel(assetSubdir, assetFilename),
        new Uint8Array(asset.bytes)
      );
      filenameById.set(id, assetFilename);
      assetsWritten++;
    } catch (err) {
      // Keep the note text and original URL when an attachment cannot be
      // read or written, and surface the incomplete export in the report.
      errors++;
      console.warn(
        '[notes-export] could not export asset',
        id,
        'for note',
        note.id,
        err
      );
    }
  }
  // 3. Rewrite the body's asset:mindstream/ URLs to point at the
  //    relative paths we just wrote, then render with frontmatter.
  const rewritten = rewriteAssetUrls(note.body, ASSET_SUBDIR, (id) =>
    filenameById.get(id)
  );
  const content = renderMarkdownFile(note, rewritten);
  await write(
    joinRel(parentDir, fileBasename),
    new TextEncoder().encode(content)
  );
  return { assets_written: assetsWritten, errors };
}

async function exportFreeform(
  write: ExportWriter,
  note: Note,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<AssetWriteSummary> {
  const excalidraw = await buildExcalidrawFile(note.yrs_state);
  if (!excalidraw) {
    // Empty doc — write an empty scene so the file still appears in
    // the export, opens cleanly, and round-trips back if re-imported.
    const empty = {
      type: 'excalidraw' as const,
      version: 2,
      source: 'https://excalidraw.com',
      elements: [],
      appState: {},
      files: {}
    };
    const basename = dedupeAgainst(
      takenFor(parentDir),
      `${sanitizeName(note.title)}.excalidraw`
    );
    await write(
      joinRel(parentDir, basename),
      new TextEncoder().encode(JSON.stringify(empty, null, 2))
    );
    return { assets_written: 0 };
  }
  const basename = dedupeAgainst(
    takenFor(parentDir),
    `${sanitizeName(note.title)}.excalidraw`
  );
  await write(
    joinRel(parentDir, basename),
    new TextEncoder().encode(JSON.stringify(excalidraw, null, 2))
  );
  return { assets_written: 0 };
}

async function exportPdf(
  write: ExportWriter,
  assets: AssetCopier | undefined,
  note: Note,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<AssetWriteSummary> {
  // PDF note body is a tiny JSON stub holding the asset id; the bytes
  // live on the assets table. See assets::import_pdf_note in the Rust
  // side for the schema.
  const pdfAssetId = pdfAssetIdFromBody(note.body);
  if (!pdfAssetId) {
    console.warn(
      '[notes-export] PDF note has no pdfAssetId in body, skipping',
      note.id
    );
    return { assets_written: 0 };
  }
  const basename = dedupeAgainst(
    takenFor(parentDir),
    `${sanitizeName(note.title)}.pdf`
  );
  const path = joinRel(parentDir, basename);
  // Nothing to draw onto the PDF, so the stored file is the export. Copy it
  // natively rather than loading a possibly large document here.
  if (assets && !pdfNoteHasOverlays(note)) {
    await assets.copy(path, pdfAssetId, 'application/pdf');
    return { assets_written: 0 };
  }
  await write(path, await buildPdfNoteBytes(note.id));
  return { assets_written: 0 };
}

async function exportInk(
  write: ExportWriter,
  note: Note,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<AssetWriteSummary> {
  // Ink note geometry lives in yrs_state — a Y.Doc holding the stroke
  // array. buildInkPdf hydrates it and renders one PDF page per ink
  // page; a blank doc still produces a valid (blank) PDF so the file
  // appears in the export just like exportFreeform's empty scene.
  const pdfBytes = await buildInkPdf(note.yrs_state);
  if (!pdfBytes) {
    console.warn(
      '[notes-export] ink note yrs_state unreadable, skipping',
      note.id
    );
    return { assets_written: 0 };
  }
  const basename = dedupeAgainst(
    takenFor(parentDir),
    `${sanitizeName(note.title)}.pdf`
  );
  await write(joinRel(parentDir, basename), pdfBytes);
  return { assets_written: 0 };
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}
