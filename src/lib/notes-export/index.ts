/**
 * Vault export driver — walks the file tree and writes one file per
 * note to disk, preserving folder hierarchy.
 *
 *   markdown → `.md` with YAML frontmatter + asset bundling
 *   freeform → `.excalidraw` JSON
 *   pdf      → `.pdf` (raw bytes from the owning asset)
 *   ink      → skipped (deliberate scope cut for v1)
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
import {
  extractAssetIds,
  renderMarkdownFile,
  rewriteAssetUrls
} from './markdown';
import { dedupeAgainst, sanitizeName } from './sanitize';

const ASSET_SUBDIR = '_assets';

export interface ExportReport {
  notes_written: number;
  folders_written: number;
  assets_written: number;
  skipped_ink: number;
  skipped_trashed: number;
  skipped_unknown_kind: number;
  errors: number;
}

export async function exportVault(root: string): Promise<ExportReport> {
  const report: ExportReport = {
    notes_written: 0,
    folders_written: 0,
    assets_written: 0,
    skipped_ink: 0,
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
    if (summary.note_kind === 'ink') {
      report.skipped_ink++;
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
      report.notes_written++;
      report.assets_written += written.assets_written;
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
    case 'markdown':
      return exportMarkdown(root, note, parentDir, takenFor);
    case 'freeform':
      return exportFreeform(root, note, parentDir, takenFor);
    case 'pdf':
      return exportPdf(root, note, parentDir, takenFor);
    default:
      // Unknown kind — count it but don't fail the whole export.
      console.warn(
        '[notes-export] unknown note kind, skipping',
        note.note_kind
      );
      return { assets_written: 0 };
  }
}

async function exportMarkdown(
  root: string,
  note: Note,
  parentDir: string,
  takenFor: (dir: string) => Set<string>
): Promise<NoteWriteSummary> {
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
): Promise<NoteWriteSummary> {
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
): Promise<NoteWriteSummary> {
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
