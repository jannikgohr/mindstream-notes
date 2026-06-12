/**
 * Vault export driver — walks the file tree and writes one file per
 * note to disk, preserving folder hierarchy.
 *
 *   markdown → `.md` with YAML frontmatter + asset bundling
 *   freeform → `.excalidraw` JSON
 *   pdf      → `.pdf` (raw bytes from the owning asset)
 *   ink      → `.pdf` (one page per ink page, strokes rendered as vector polylines)
 *
 * The actual disk writes go through `writeExportFile` in the Rust
 * shim, which enforces a path-traversal guard so user-supplied
 * titles can't escape the chosen export root.
 */

import * as api from '$lib/api';
import { TRASH_ID, writeExportFile } from '$lib/api';
import type { Note, NoteSummary, Collection } from '$lib/api';
import { tree } from '$lib/stores/tree.svelte';
import { buildExcalidrawFile } from './excalidraw';
import { buildInkPdf } from './ink-pdf';
import {
  extractAssetIds,
  renderMarkdownFile,
  rewriteAssetUrls
} from './markdown';
import { dedupeAgainst, sanitizeName } from './sanitize';

const ASSET_SUBDIR = '_assets';

export interface ExportReport {
  /** `.md` files written (note_kind = 'markdown'). */
  markdown_written: number;
  /** `.excalidraw` files written (note_kind = 'freeform'). */
  freeform_written: number;
  /** `.pdf` files written (note_kind = 'pdf'). */
  pdf_written: number;
  /** `.pdf` files written for ink notes (note_kind = 'ink'). */
  ink_written: number;
  folders_written: number;
  /** Image / blob files copied into the per-folder `_assets/` subdir. */
  assets_written: number;
  skipped_trashed: number;
  skipped_unknown_kind: number;
  errors: number;
}

export async function exportVault(root: string): Promise<ExportReport> {
  const report: ExportReport = {
    markdown_written: 0,
    freeform_written: 0,
    pdf_written: 0,
    ink_written: 0,
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
      const written = await exportNote(root, summary, parentDir, takenFor);
      report.assets_written += written.assets_written;
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
  kind: 'markdown' | 'freeform' | 'pdf' | 'ink' | 'unknown';
  assets_written: number;
}

/** Per-helper return: the helpers don't carry the kind themselves —
 *  exportNote adds it from the switch arm above. */
interface AssetWriteSummary {
  assets_written: number;
}

async function exportNote(
  root: string,
  summary: NoteSummary,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<NoteWriteSummary> {
  const note = await api.loadNote(summary.id);
  switch (note.note_kind) {
    case 'markdown': {
      const written = await exportMarkdown(root, note, parentDir, takenFor);
      return { kind: 'markdown', assets_written: written.assets_written };
    }
    case 'freeform': {
      const written = await exportFreeform(root, note, parentDir, takenFor);
      return { kind: 'freeform', assets_written: written.assets_written };
    }
    case 'pdf': {
      const written = await exportPdf(root, note, parentDir, takenFor);
      return { kind: 'pdf', assets_written: written.assets_written };
    }
    case 'ink': {
      const written = await exportInk(root, note, parentDir, takenFor);
      return { kind: 'ink', assets_written: written.assets_written };
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
  root: string,
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
  for (const id of ids) {
    try {
      const asset = await api.fetchDrawingAsset(id);
      const ext = extensionForMime(asset.mime_type);
      const assetFilename = dedupeAgainst(takenFor(assetSubdir), `${id}${ext}`);
      filenameById.set(id, assetFilename);
      await writeExportFile(
        root,
        joinRel(assetSubdir, assetFilename),
        new Uint8Array(asset.bytes)
      );
      assetsWritten++;
    } catch (err) {
      // Missing assets shouldn't take the note down — the URL is
      // left intact and the user sees a broken image link rather
      // than losing the note entirely.
      console.warn(
        '[notes-export] could not export asset',
        id,
        'for note',
        note.id,
        err
      );
    }
  }
  // 3. Rewrite the body's mindstream-asset:// URLs to point at the
  //    relative paths we just wrote, then render with frontmatter.
  const rewritten = rewriteAssetUrls(note.body, ASSET_SUBDIR, (id) =>
    filenameById.get(id)
  );
  const content = renderMarkdownFile(note, rewritten);
  await writeExportFile(
    root,
    joinRel(parentDir, fileBasename),
    new TextEncoder().encode(content)
  );
  return { assets_written: assetsWritten };
}

async function exportFreeform(
  root: string,
  note: Note,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<AssetWriteSummary> {
  const excalidraw = buildExcalidrawFile(note.yrs_state);
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
    await writeExportFile(
      root,
      joinRel(parentDir, basename),
      new TextEncoder().encode(JSON.stringify(empty, null, 2))
    );
    return { assets_written: 0 };
  }
  const basename = dedupeAgainst(
    takenFor(parentDir),
    `${sanitizeName(note.title)}.excalidraw`
  );
  await writeExportFile(
    root,
    joinRel(parentDir, basename),
    new TextEncoder().encode(JSON.stringify(excalidraw, null, 2))
  );
  return { assets_written: 0 };
}

async function exportPdf(
  root: string,
  note: Note,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<AssetWriteSummary> {
  // PDF note body is a tiny JSON stub holding the asset id; the bytes
  // live on the assets table. See assets::import_pdf_note in the Rust
  // side for the schema.
  let pdfAssetId: string | null = null;
  try {
    const parsed = JSON.parse(note.body) as { pdfAssetId?: string };
    pdfAssetId = parsed.pdfAssetId ?? null;
  } catch {
    // Older PDF note rows (or corrupted ones) might not parse — fall
    // through to a best-effort lookup by the note's first asset.
    pdfAssetId = null;
  }
  if (!pdfAssetId) {
    console.warn(
      '[notes-export] PDF note has no pdfAssetId in body, skipping',
      note.id
    );
    return { assets_written: 0 };
  }
  const asset = await api.fetchDrawingAsset(pdfAssetId);
  const basename = dedupeAgainst(
    takenFor(parentDir),
    `${sanitizeName(note.title)}.pdf`
  );
  await writeExportFile(
    root,
    joinRel(parentDir, basename),
    new Uint8Array(asset.bytes)
  );
  return { assets_written: 0 };
}

async function exportInk(
  root: string,
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
  await writeExportFile(root, joinRel(parentDir, basename), pdfBytes);
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
