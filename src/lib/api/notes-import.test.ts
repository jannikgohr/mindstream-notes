import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import {
  cancelImport,
  convertLegacyWikilinks,
  detectImportSource,
  legacyWikilinkCount,
  pickImportFile,
  pickImportFolder,
  runImport,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  type ImportOptions
} from './notes-import';

function setTauri(on: boolean): void {
  if (on)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

const OPTIONS: ImportOptions = {
  source_path: '/vault',
  kind: 'obsidian',
  destination_collection_id: null,
  create_folder_named: 'My vault',
  import_attachments: true,
  max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
  unresolved_links: 'plain-text'
};

const REPORT = {
  notes_created: 3,
  folders_created: 1,
  placeholders_created: 0,
  attachments_imported: 2,
  attachments_deduplicated: 1,
  attachments_too_large: 0,
  links_resolved: 4,
  links_unresolved: 1,
  errors: 0,
  cancelled: false
};

describe('notes-import — outside Tauri', () => {
  // The pickers returning null is what makes the settings action end quietly
  // in the browser preview instead of throwing, matching pickExportDir.
  it('the pickers resolve to null rather than throwing', async () => {
    await expect(pickImportFolder()).resolves.toBeNull();
    await expect(pickImportFile()).resolves.toBeNull();
  });

  it('detect and run resolve to null', async () => {
    await expect(detectImportSource('/vault')).resolves.toBeNull();
    await expect(runImport(OPTIONS)).resolves.toBeNull();
  });

  it('cancel is a no-op', async () => {
    await expect(cancelImport()).resolves.toBeUndefined();
  });
});

describe('notes-import — inside Tauri', () => {
  beforeEach(() => {
    setTauri(true);
    invoke.mockReset();
  });
  afterEach(() => setTauri(false));

  it('forwards the options object under the key Rust expects', async () => {
    invoke.mockResolvedValue(REPORT);
    await expect(runImport(OPTIONS)).resolves.toEqual(REPORT);
    expect(invoke).toHaveBeenCalledWith('notes_import_run', {
      options: OPTIONS
    });
  });

  it('parses a detected source', async () => {
    invoke.mockResolvedValue({
      kind: 'joplin-jex',
      path: '/tmp/export.jex',
      suggested_name: 'export'
    });
    await expect(detectImportSource('/tmp/export.jex')).resolves.toEqual({
      kind: 'joplin-jex',
      path: '/tmp/export.jex',
      suggested_name: 'export'
    });
  });

  it('rejects a source kind it does not know', async () => {
    // A kind the frontend has no label for would otherwise render as a blank
    // option in the format select.
    invoke.mockResolvedValue({
      kind: 'onenote',
      path: '/x',
      suggested_name: 'x'
    });
    await expect(detectImportSource('/x')).rejects.toThrow(/onenote/);
  });

  it('rejects a report with a missing counter', async () => {
    const { errors: _errors, ...incomplete } = REPORT;
    invoke.mockResolvedValue(incomplete);
    await expect(runImport(OPTIONS)).rejects.toThrow(/report.errors/);
  });

  it('round-trips a cancelled report', async () => {
    invoke.mockResolvedValue({ ...REPORT, cancelled: true, notes_created: 1 });
    const report = await runImport(OPTIONS);
    expect(report?.cancelled).toBe(true);
    expect(report?.notes_created).toBe(1);
  });

  it('a cancelled picker comes back as null', async () => {
    invoke.mockResolvedValue(null);
    await expect(pickImportFolder()).resolves.toBeNull();
  });
});

describe('legacy wikilink conversion', () => {
  it('reports nothing to do outside Tauri', async () => {
    await expect(legacyWikilinkCount()).resolves.toBe(0);
    await expect(convertLegacyWikilinks()).resolves.toBeNull();
  });

  describe('inside Tauri', () => {
    beforeEach(() => {
      setTauri(true);
      invoke.mockReset();
    });
    afterEach(() => setTauri(false));

    it('parses the conversion report', async () => {
      const report = {
        notes_scanned: 4,
        notes_converted: 3,
        links_converted: 7,
        links_unresolved: 1
      };
      invoke.mockResolvedValue(report);
      await expect(convertLegacyWikilinks()).resolves.toEqual(report);
      expect(invoke).toHaveBeenCalledWith(
        'convert_legacy_wikilinks_command',
        undefined
      );
    });

    it('rejects a non-numeric count', async () => {
      invoke.mockResolvedValue('many');
      await expect(legacyWikilinkCount()).rejects.toThrow(
        /legacy_wikilink_count/
      );
    });
  });
});
