/**
 * Vault import bridge — mirror of `src-tauri/src/import/`.
 *
 * Unlike the export side, which drives the whole loop from TypeScript and uses
 * Rust only as a filesystem shim, the import runs entirely in Rust: it is
 * bytes-on-disk to SQLite rows, with a million-note target, and one IPC call
 * per file would dominate. This module is therefore thin — pick a source,
 * detect its format, start the run, watch progress.
 *
 * A browser picks files through its own dialogs and hands them to the storage
 * worker, which runs the same importer. The in-memory fixture build has no
 * vault to import into, so there the pickers return `null` and the flow ends
 * quietly.
 */

import {
  assertBoolean,
  assertNumber,
  assertRecord,
  assertString,
  isTauri,
  TauriCommandName,
  invokeTauri
} from './core';
import { emit, TauriEventName } from './events';
import { flushPendingEditorSaves } from '../editor/suspend-flush';
import { browserStorageEnabled } from '../browser/commands';
import { pickFiles } from '../browser/pick-files';
import type { PickedSource } from '../browser/protocol';

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
  /**
   * Every report counter as of the last commit. Optional so progress from
   * older payloads, and test fixtures that only track the phase, still type.
   * A browser import commits only at the end, so its pings carry zeros.
   */
  committed?: ImportReport;
}

const REPORT_COUNTERS = {
  notes_created: 0,
  folders_created: 0,
  placeholders_created: 0,
  attachments_imported: 0,
  attachments_deduplicated: 0,
  attachments_too_large: 0,
  links_resolved: 0,
  links_unresolved: 0,
  errors: 0
} satisfies Record<Exclude<keyof ImportReport, 'cancelled'>, number>;
const EMPTY_REPORT: ImportReport = { ...REPORT_COUNTERS, cancelled: false };

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

/** The browser's pick, kept here because a `File` can't travel in a path. */
let picked: PickedSource | null = null;
let running: { cancelled: boolean } | null = null;

export async function pickImportFolder(): Promise<string | null> {
  if (!isTauri()) {
    if (!browserStorageEnabled()) return null;
    const files = await pickFiles((input) => {
      input.webkitdirectory = true;
    });
    if (!files?.length) return null;
    // Each path starts with the name of the folder the user picked.
    const name = files[0].webkitRelativePath.split('/')[0];
    picked = {
      name,
      single: false,
      files: files.map((file) => ({
        path: file.webkitRelativePath.slice(name.length + 1),
        file
      }))
    };
    return name;
  }
  return parseNullableString(
    await invokeTauri<unknown>(TauriCommandName.NotesImportPickFolder)
  );
}

export async function pickImportFile(): Promise<string | null> {
  if (!isTauri()) {
    if (!browserStorageEnabled()) return null;
    const files = await pickFiles((input) => {
      input.accept = '.enex,.jex';
    });
    const file = files?.[0];
    if (!file) return null;
    picked = {
      name: file.name,
      single: true,
      files: [{ path: file.name, file }]
    };
    return file.name;
  }
  return parseNullableString(
    await invokeTauri<unknown>(TauriCommandName.NotesImportPickFile)
  );
}

export async function detectImportSource(
  path: string
): Promise<DetectedSource | null> {
  if (!isTauri()) {
    if (!picked) return null;
    const { detectBrowserNotes } = await import('../browser/vault');
    return parseDetected(await detectBrowserNotes(picked));
  }
  return parseDetected(
    await invokeTauri<unknown>(TauriCommandName.NotesImportDetect, { path })
  );
}

export async function runImport(
  options: ImportOptions
): Promise<ImportReport | null> {
  if (!isTauri() && !picked) return null;
  // The import holds the vault's write lock until it ends. What the editors
  // still hold is saved first, rather than waiting behind it.
  await flushPendingEditorSaves();
  if (!isTauri()) return runBrowserImport(picked!, options);
  return parseReport(
    await invokeTauri<unknown>(TauriCommandName.NotesImportRun, { options })
  );
}

async function runBrowserImport(
  source: PickedSource,
  options: ImportOptions
): Promise<ImportReport> {
  const { importBrowserNotes } = await import('../browser/vault');
  const run = { cancelled: false };
  running = run;
  try {
    const report = parseReport(
      await importBrowserNotes(source, { ...options }, (progress) => {
        void emit(TauriEventName.ImportProgress, progress);
      })
    );
    picked = null;
    return report;
  } catch (error) {
    // A failed run keeps the pick: the dialog goes back to its options, and
    // Import there runs the same source again.
    if (!run.cancelled) throw error;
    picked = null;
    // The browser runs an import as one transaction, so a stopped one leaves
    // nothing behind: the next open of the vault rolls it back.
    return { ...EMPTY_REPORT, cancelled: true };
  } finally {
    running = null;
    // As the app's import command does, however the run ended.
    void emit(TauriEventName.ImportProgress, {
      phase: 'finished',
      done: 0,
      total: 0
    });
  }
}

/**
 * Ask a running import to stop, with the report coming back as
 * `cancelled: true`. The app's run finishes its current batch and keeps
 * everything already written. A browser run is one transaction and keeps
 * nothing.
 */
export async function cancelImport(): Promise<void> {
  if (!isTauri()) {
    if (!running) return;
    running.cancelled = true;
    const { cancelBrowserNotesImport } = await import('../browser/vault');
    cancelBrowserNotesImport();
    return;
  }
  await invokeTauri<unknown>(TauriCommandName.NotesImportCancel);
}

/** How many notes still contain a `[[…]]` span. `0` outside Tauri. */
export async function legacyWikilinkCount(): Promise<number> {
  if (!isTauri()) return 0;
  return assertNumber(
    await invokeTauri<unknown>(TauriCommandName.LegacyWikilinkCount),
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
    await invokeTauri<unknown>(TauriCommandName.ConvertLegacyWikilinks),
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
  const counters = Object.fromEntries(
    Object.keys(REPORT_COUNTERS).map((key) => [
      key,
      assertNumber(raw[key], `report.${key}`)
    ])
  ) as Omit<ImportReport, 'cancelled'>;
  return {
    ...counters,
    cancelled: assertBoolean(raw.cancelled, 'report.cancelled')
  };
}
