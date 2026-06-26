import { beforeEach, describe, expect, it } from 'vitest';
import {
  exportResultQueue,
  showBackupResult,
  showDataResult,
  showExportResult,
  showMergeResult,
  showRestoreReadyResult,
  type DataResultChip
} from './export-result-dialog.svelte';
import type {
  BackupReport,
  ImportPreview,
  MergeReport,
  RestoreStaged
} from '$lib/api';
import type { ExportReport } from '$lib/notes-export';

const exportReport = (over: Partial<ExportReport> = {}): ExportReport => ({
  markdown_written: 0,
  freeform_written: 0,
  pdf_written: 0,
  ink_written: 0,
  folders_written: 0,
  assets_written: 0,
  skipped_trashed: 0,
  skipped_unknown_kind: 0,
  errors: 0,
  ...over
});

const chipByIcon = (chips: DataResultChip[], icon: DataResultChip['icon']) =>
  chips.find((c) => c.icon === icon);

beforeEach(() => {
  exportResultQueue.items = [];
});

describe('showDataResult queue', () => {
  it('enqueues an item and resolves it with the chosen action', async () => {
    const promise = showDataResult({
      titleKey: 't',
      headerIcon: 'archive',
      tone: 'sky',
      chips: []
    });
    expect(exportResultQueue.items).toHaveLength(1);
    exportResultQueue.items[0].resolve('close');
    await expect(promise).resolves.toBe('close');
  });

  it('preserves FIFO order across multiple enqueues', () => {
    void showDataResult({
      titleKey: 'a',
      headerIcon: 'archive',
      tone: 'sky',
      chips: []
    });
    void showDataResult({
      titleKey: 'b',
      headerIcon: 'cloud',
      tone: 'teal',
      chips: []
    });
    expect(exportResultQueue.items.map((i) => i.titleKey)).toEqual(['a', 'b']);
  });
});

describe('showExportResult', () => {
  it('records the destination as the dialog location', () => {
    void showExportResult(exportReport({ markdown_written: 3 }), '/tmp/vault');
    const opts = exportResultQueue.items[0];
    expect(opts.location?.path).toBe('/tmp/vault');
    expect(opts.tone).toBe('emerald');
  });

  it('always shows the notes chip but hides zero-count optional chips', () => {
    void showExportResult(
      exportReport({ markdown_written: 5, pdf_written: 0, errors: 0 }),
      '/d'
    );
    const chips = exportResultQueue.items[0].chips;
    expect(chipByIcon(chips, 'fileText')?.show).toBe(true);
    expect(chipByIcon(chips, 'fileType')?.show).toBe(false);
    expect(chipByIcon(chips, 'alertTriangle')?.show).toBe(false);
  });

  it('reveals optional chips once their counts are positive', () => {
    void showExportResult(
      exportReport({
        pdf_written: 2,
        ink_written: 1,
        freeform_written: 4,
        assets_written: 7,
        errors: 1
      }),
      '/d'
    );
    const chips = exportResultQueue.items[0].chips;
    expect(chipByIcon(chips, 'fileType')?.show).toBe(true);
    expect(chipByIcon(chips, 'feather')?.show).toBe(true);
    expect(chipByIcon(chips, 'pencilRuler')?.show).toBe(true);
    expect(chipByIcon(chips, 'paperclip')?.show).toBe(true);
    expect(chipByIcon(chips, 'alertTriangle')?.show).toBe(true);
    expect(chipByIcon(chips, 'alertTriangle')?.count).toBe(1);
  });
});

describe('showBackupResult', () => {
  const report = (over: Partial<BackupReport> = {}): BackupReport => ({
    destination: '/backups/vault.zip',
    counts: { notes: 10, folders: 3, assets_bytes: 2048 },
    account_present: true,
    ...over
  });

  it('derives the open location from the destination parent dir', () => {
    void showBackupResult(report());
    const loc = exportResultQueue.items[0].location;
    expect(loc?.path).toBe('/backups/vault.zip');
    expect(loc?.openPath).toBe('/backups');
  });

  it('marks the account chip as cloud when the account is present', () => {
    void showBackupResult(report({ account_present: true }));
    const chip = chipByIcon(exportResultQueue.items[0].chips, 'cloud');
    expect(chip?.tone).toBe('teal');
  });

  it('marks the account chip as local-only hard drive when absent', () => {
    void showBackupResult(report({ account_present: false }));
    const chips = exportResultQueue.items[0].chips;
    expect(chipByIcon(chips, 'hardDrive')?.tone).toBe('amber');
    expect(chipByIcon(chips, 'cloud')).toBeUndefined();
  });

  it('formats the attachment bytes into a human chip', () => {
    void showBackupResult(
      report({ counts: { notes: 1, folders: 1, assets_bytes: 1024 } })
    );
    const chip = chipByIcon(exportResultQueue.items[0].chips, 'paperclip');
    expect(chip?.countText).toMatch(/KB|kB|1024|1\.0/);
  });
});

describe('showMergeResult', () => {
  const report = (over: Partial<MergeReport> = {}): MergeReport => ({
    folders_added: 2,
    notes_added: 5,
    assets_added: 1,
    notes_orphaned: 0,
    ...over
  });

  it('flags orphaned notes with an amber tone only when present', () => {
    void showMergeResult(report({ notes_orphaned: 0 }));
    expect(
      chipByIcon(exportResultQueue.items[0].chips, 'alertTriangle')?.tone
    ).toBe('emerald');

    exportResultQueue.items = [];
    void showMergeResult(report({ notes_orphaned: 3 }));
    expect(
      chipByIcon(exportResultQueue.items[0].chips, 'alertTriangle')?.tone
    ).toBe('amber');
  });
});

describe('showRestoreReadyResult', () => {
  const preview = (sameAccount: boolean): ImportPreview =>
    ({
      token: 'tok',
      backup_counts: { notes: 4, folders: 2, assets_bytes: 512 },
      current_counts: { notes: 0, folders: 0, assets_bytes: 0 },
      backup_app_version: '0.1.0',
      backup_created_at: '2024-01-01',
      same_account: sameAccount,
      backup_account: null,
      current_account: null
    }) as ImportPreview;

  const staged = (sanitized: boolean): RestoreStaged => ({
    restart_required: true,
    sanitized
  });

  it('offers restart and later actions with later as default', () => {
    void showRestoreReadyResult(preview(true), staged(false));
    const opts = exportResultQueue.items[0];
    expect(opts.primaryAction?.value).toBe('restart');
    expect(opts.secondaryAction?.value).toBe('later');
    expect(opts.defaultAction).toBe('later');
  });

  it('chooses the description key from the sanitized flag', () => {
    void showRestoreReadyResult(preview(true), staged(true));
    expect(exportResultQueue.items[0].descriptionKey).toMatch(/sanitized$/);

    exportResultQueue.items = [];
    void showRestoreReadyResult(preview(true), staged(false));
    expect(exportResultQueue.items[0].descriptionKey).toMatch(/preserved$/);
  });

  it('shows a sync chip whose tone tracks same-account', () => {
    void showRestoreReadyResult(preview(false), staged(false));
    const chips = exportResultQueue.items[0].chips;
    expect(chipByIcon(chips, 'hardDrive')?.tone).toBe('amber');
  });
});
