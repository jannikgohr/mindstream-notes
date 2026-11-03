import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

const browser = vi.hoisted(() => ({
  enabled: false,
  pick: vi.fn(),
  detect: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn()
}));
vi.mock('../browser/commands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../browser/commands')>()),
  browserStorageEnabled: () => browser.enabled
}));
vi.mock('../browser/pick-files', () => ({ pickFiles: browser.pick }));
vi.mock('../browser/vault', () => ({
  detectBrowserNotes: browser.detect,
  importBrowserNotes: browser.run,
  cancelBrowserNotesImport: browser.cancel
}));

import { listen, TauriEventName } from './events';
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

describe('notes-import — browser storage', () => {
  const report = {
    notes_created: 2,
    folders_created: 1,
    placeholders_created: 0,
    attachments_imported: 0,
    attachments_deduplicated: 0,
    attachments_too_large: 0,
    links_resolved: 3,
    links_unresolved: 0,
    errors: 0,
    cancelled: false
  };
  const folder = (name: string, ...paths: string[]) =>
    paths.map((path) => {
      const file = new File(['text'], path.split('/').at(-1)!);
      Object.defineProperty(file, 'webkitRelativePath', {
        value: `${name}/${path}`
      });
      return file;
    });

  beforeEach(() => {
    browser.enabled = true;
    for (const mock of [
      browser.pick,
      browser.detect,
      browser.run,
      browser.cancel
    ])
      mock.mockReset();
  });
  afterEach(() => {
    browser.enabled = false;
  });

  it('keeps paths relative to the picked folder', async () => {
    const files = folder('Vault', 'a.md', 'sub/b.md');
    browser.pick.mockResolvedValue(files);
    browser.detect.mockResolvedValue({
      kind: 'obsidian',
      path: 'Vault',
      suggested_name: 'Vault'
    });

    expect(await pickImportFolder()).toBe('Vault');
    const input = document.createElement('input');
    browser.pick.mock.calls[0][0](input);
    expect(input.webkitdirectory).toBe(true);

    expect(await detectImportSource('Vault')).toMatchObject({
      kind: 'obsidian'
    });
    expect(browser.detect).toHaveBeenCalledWith({
      name: 'Vault',
      single: false,
      files: [
        { path: 'a.md', file: files[0] },
        { path: 'sub/b.md', file: files[1] }
      ]
    });
  });

  it('treats a picked file as one source', async () => {
    const file = new File(['xml'], 'export.enex');
    browser.pick.mockResolvedValue([file]);
    browser.detect.mockResolvedValue({
      kind: 'evernote',
      path: 'export.enex',
      suggested_name: 'export'
    });

    expect(await pickImportFile()).toBe('export.enex');
    const input = document.createElement('input');
    browser.pick.mock.calls[0][0](input);
    expect(input.accept).toBe('.enex,.jex');

    await detectImportSource('export.enex');
    expect(browser.detect).toHaveBeenCalledWith({
      name: 'export.enex',
      single: true,
      files: [{ path: 'export.enex', file }]
    });
  });

  it('stays quiet when a picker is cancelled or picks nothing', async () => {
    browser.pick.mockResolvedValueOnce(null);
    expect(await pickImportFolder()).toBeNull();
    browser.pick.mockResolvedValueOnce([]);
    expect(await pickImportFolder()).toBeNull();
    browser.pick.mockResolvedValueOnce(null);
    expect(await pickImportFile()).toBeNull();
  });

  async function pickAndHoldRun() {
    browser.pick.mockResolvedValue(folder('Vault', 'a.md'));
    await pickImportFolder();
    let reject!: (reason: unknown) => void;
    let resolve!: (value: unknown) => void;
    browser.run.mockImplementation(
      () =>
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        })
    );
    const run = runImport(OPTIONS);
    await vi.waitFor(() => expect(browser.run).toHaveBeenCalled());
    return { run, reject: (reason: unknown) => reject(reason), resolve };
  }

  it('reports progress through the same event as the app', async () => {
    const { run, resolve } = await pickAndHoldRun();
    const heard: unknown[] = [];
    const off = await listen(TauriEventName.ImportProgress, (progress) =>
      heard.push(progress)
    );
    const update = {
      phase: 'importing',
      done: 500,
      total: 900,
      committed: REPORT
    };
    browser.run.mock.calls[0][2](update);
    off();

    resolve(report);
    await expect(run).resolves.toEqual(report);
    expect(heard).toEqual([update]);
    expect(browser.run.mock.calls[0][1]).toEqual(OPTIONS);
  });

  it('reports what committed when the user stops the run', async () => {
    const { run, reject } = await pickAndHoldRun();
    // 520 items were processed, but 20 of them failed, so only 500 notes landed.
    // The snapshot also carries the folder and placeholder counts.
    browser.run.mock.calls[0][2]({
      phase: 'importing',
      done: 520,
      total: 900,
      committed: {
        ...REPORT,
        notes_created: 500,
        folders_created: 1,
        placeholders_created: 2,
        errors: 3,
        cancelled: false
      }
    });

    await cancelImport();
    expect(browser.cancel).toHaveBeenCalledOnce();
    reject({ code: 'closed', message: 'Storage worker is closed' });

    await expect(run).resolves.toEqual({
      ...REPORT,
      notes_created: 500,
      folders_created: 1,
      placeholders_created: 2,
      errors: 3,
      cancelled: true
    });
  });

  it('reports nothing committed when the user stops before any batch', async () => {
    const { run, reject } = await pickAndHoldRun();
    browser.run.mock.calls[0][2]({ phase: 'scanning', done: 0, total: 900 });

    await cancelImport();
    reject({ code: 'closed', message: 'Storage worker is closed' });

    await expect(run).resolves.toEqual({
      notes_created: 0,
      folders_created: 0,
      placeholders_created: 0,
      attachments_imported: 0,
      attachments_deduplicated: 0,
      attachments_too_large: 0,
      links_resolved: 0,
      links_unresolved: 0,
      errors: 0,
      cancelled: true
    });
  });

  it('does not mistake a failed run for a stopped one', async () => {
    const { run, reject } = await pickAndHoldRun();
    const failure = { code: 'database', message: 'Disk full' };
    reject(failure);
    await expect(run).rejects.toBe(failure);
  });

  it('has nothing to stop or run without a pick', async () => {
    await cancelImport();
    expect(browser.cancel).not.toHaveBeenCalled();
    expect(await runImport(OPTIONS)).toBeNull();
    expect(await detectImportSource('Vault')).toBeNull();
  });

  it('forgets the pick after a run', async () => {
    const { run, resolve } = await pickAndHoldRun();
    resolve(report);
    await run;
    expect(await runImport(OPTIONS)).toBeNull();
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
