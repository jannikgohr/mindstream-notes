/**
 * Vault import bridge — mirror of `src-tauri/src/import/`.
 *
 * Unlike the export side, which drives the whole loop from TypeScript and uses
 * Rust only as a filesystem shim, the import runs entirely in Rust: it is
 * bytes-on-disk to SQLite rows, with a million-note target, and one IPC call
 * per file would dominate. This module is therefore thin — pick a source,
 * detect its format, start the run, watch progress.
 *
 * Outside Tauri the pickers return `null`, so the flow ends quietly instead of
 * throwing, exactly as `pickExportDir` does today.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  assertBoolean,
  assertNumber,
  assertRecord,
  assertString,
  isTauri,
  TauriCommandName
} from './core';

/** Formats the importer recognises. Mirrors Rust's `ImportSourceKind`. */
export type ImportSourceKind =
  | 'gfm'
  | 'obsidian'
  | 'joplin-raw'
  | 'joplin-jex'
  | 'joplin-markdown'
  | 'evernote';

export const IMPORT_SOURCE_KINDS: readonly ImportSourceKind[] = [
  'gfm',
  'obsidian',
  'joplin-raw',
  'joplin-jex',
  'joplin-markdown',
  'evernote'
];

/** What to do with a link whose target isn't in the source. */
export type UnresolvedLinksPolicy = 'plain-text' | 'create-placeholder';

export interface DetectedSource {
  kind: ImportSourceKind;
  path: string;
  /** Folder name to offer as the import destination. */
  suggested_name: string;
}

export interface ImportOptions {
  source_path: string;
  kind: ImportSourceKind | null;
  /** Existing folder to import into; `null` is the vault root. */
  destination_collection_id: string | null;
  /** Create a new folder with this name and put everything inside it. */
  create_folder_named: string | null;
  import_attachments: boolean;
  max_attachment_bytes: number;
  unresolved_links: UnresolvedLinksPolicy;
}

export interface ImportReport {
  notes_created: number;
  folders_created: number;
  placeholders_created: number;
  attachments_imported: number;
  attachments_deduplicated: number;
  attachments_too_large: number;
  links_resolved: number;
  links_unresolved: number;
  errors: number;
  cancelled: boolean;
}

export interface ImportProgress {
  phase: string;
  done: number;
  total: number;
}

/** Outcome of converting bare `[[Title]]` spans into ID-backed links. */
export interface LegacyLinkReport {
  notes_scanned: number;
  notes_converted: number;
  links_converted: number;
  /** Spans left as written because no note has that title. */
  links_unresolved: number;
}

/** Default per-file attachment ceiling, matching the Rust constant. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function pickImportFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  return parseNullableString(
    await tauriInvoke<unknown>(TauriCommandName.NotesImportPickFolder)
  );
}

export async function pickImportFile(): Promise<string | null> {
  if (!isTauri()) return null;
  return parseNullableString(
    await tauriInvoke<unknown>(TauriCommandName.NotesImportPickFile)
  );
}

export async function detectImportSource(
  path: string
): Promise<DetectedSource | null> {
  if (!isTauri()) return null;
  return parseDetected(
    await tauriInvoke<unknown>(TauriCommandName.NotesImportDetect, { path })
  );
}

export async function runImport(
  options: ImportOptions
): Promise<ImportReport | null> {
  if (!isTauri()) return null;
  return parseReport(
    await tauriInvoke<unknown>(TauriCommandName.NotesImportRun, { options })
  );
}

/**
 * Ask a running import to stop. The run finishes its current batch and keeps
 * everything already written — a partial import is a real outcome, not a
 * failure, so the report comes back with `cancelled: true`.
 */
export async function cancelImport(): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<unknown>(TauriCommandName.NotesImportCancel);
}

/** How many notes still contain a `[[…]]` span. `0` outside Tauri. */
export async function legacyWikilinkCount(): Promise<number> {
  if (!isTauri()) return 0;
  return assertNumber(
    await tauriInvoke<unknown>(TauriCommandName.LegacyWikilinkCount),
    'legacy_wikilink_count response'
  );
}

/**
 * Rewrite every resolvable `[[Title]]` in the vault as an ID-backed link.
 * Rewrites note bodies — each one is a CRDT edit and a sync push — which is
 * why the settings action asks first.
 */
export async function convertLegacyWikilinks(): Promise<LegacyLinkReport | null> {
  if (!isTauri()) return null;
  const raw = assertRecord(
    await tauriInvoke<unknown>(TauriCommandName.ConvertLegacyWikilinks),
    'legacy link report'
  );
  return {
    notes_scanned: assertNumber(raw.notes_scanned, 'legacy.notes_scanned'),
    notes_converted: assertNumber(
      raw.notes_converted,
      'legacy.notes_converted'
    ),
    links_converted: assertNumber(
      raw.links_converted,
      'legacy.links_converted'
    ),
    links_unresolved: assertNumber(
      raw.links_unresolved,
      'legacy.links_unresolved'
    )
  };
}

function parseNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, 'import picker response');
}

function parseDetected(value: unknown): DetectedSource {
  const raw = assertRecord(value, 'detected source');
  return {
    kind: parseKind(raw.kind),
    path: assertString(raw.path, 'detected.path'),
    suggested_name: assertString(raw.suggested_name, 'detected.suggested_name')
  };
}

function parseKind(value: unknown): ImportSourceKind {
  const kind = assertString(value, 'detected.kind');
  if (!(IMPORT_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown import source kind ${kind}`);
  }
  return kind as ImportSourceKind;
}

function parseReport(value: unknown): ImportReport {
  const raw = assertRecord(value, 'import report');
  return {
    notes_created: assertNumber(raw.notes_created, 'report.notes_created'),
    folders_created: assertNumber(
      raw.folders_created,
      'report.folders_created'
    ),
    placeholders_created: assertNumber(
      raw.placeholders_created,
      'report.placeholders_created'
    ),
    attachments_imported: assertNumber(
      raw.attachments_imported,
      'report.attachments_imported'
    ),
    attachments_deduplicated: assertNumber(
      raw.attachments_deduplicated,
      'report.attachments_deduplicated'
    ),
    attachments_too_large: assertNumber(
      raw.attachments_too_large,
      'report.attachments_too_large'
    ),
    links_resolved: assertNumber(raw.links_resolved, 'report.links_resolved'),
    links_unresolved: assertNumber(
      raw.links_unresolved,
      'report.links_unresolved'
    ),
    errors: assertNumber(raw.errors, 'report.errors'),
    cancelled: assertBoolean(raw.cancelled, 'report.cancelled')
  };
}
