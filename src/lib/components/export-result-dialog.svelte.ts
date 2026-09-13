/**
 * Queue + imperative API for Data-section result dialogs. The visual
 * component is still `ExportResultDialog.svelte` because that singleton
 * started life as the export-vault summary, but the queue is now generic:
 * export, backup, merge, and restore all share the same shell.
 */

import type {
  BackupReport,
  ImportPreview,
  ImportReport,
  MergeReport,
  RestoreStaged
} from '$lib/api';
import type { ExportReport } from '$lib/notes-export';
import { formatBytes } from '$lib/utils';

/**
 * Tones are SEMANTIC, not decorative. They previously named hues
 * (emerald / sky / amber / violet / teal), which meant the chips were colour
 * coded by note kind — so the "ink notes" chip rendered amber and read as a
 * warning even in a fully successful export. Category is already carried by
 * each chip's own icon and label, so category chips are now neutral and
 * colour is reserved for things that actually have a status.
 */
export type DataResultTone = 'neutral' | 'success' | 'warning' | 'destructive';

export type DataResultIcon =
  | 'archive'
  | 'alertTriangle'
  | 'cloud'
  | 'feather'
  | 'fileText'
  | 'fileType'
  | 'folder'
  | 'gitMerge'
  | 'hardDrive'
  | 'paperclip'
  | 'partyPopper'
  | 'pencilRuler'
  | 'rotateCcw';

export interface DataResultChip {
  count?: number;
  countText?: string;
  countTextKey?: string;
  oneKey?: string;
  otherKey?: string;
  labelKey?: string;
  statusKey: string;
  icon: DataResultIcon;
  tone: DataResultTone;
  show?: boolean;
}

export interface DataResultAction {
  labelKey: string;
  value: string;
  variant?: 'default' | 'destructive' | 'ghost' | 'outline';
}

export interface DataResultLocation {
  labelKey: string;
  actionLabelKey: string;
  path: string;
  openPath?: string;
}

export interface DataResultOptions {
  titleKey: string;
  descriptionKey?: string;
  descriptionValues?: Record<string, string | number | boolean>;
  headerIcon: DataResultIcon;
  tone: DataResultTone;
  chips: DataResultChip[];
  location?: DataResultLocation;
  primaryAction?: DataResultAction;
  secondaryAction?: DataResultAction;
  defaultAction?: string;
}

export interface PendingDataResult extends DataResultOptions {
  resolve: (action: string) => void;
}

export const exportResultQueue = $state<{ items: PendingDataResult[] }>({
  items: []
});

export function showDataResult(opts: DataResultOptions): Promise<string> {
  return new Promise((resolve) => {
    exportResultQueue.items = [
      ...exportResultQueue.items,
      { ...opts, resolve }
    ];
  });
}

export function showExportResult(
  report: ExportReport,
  destination: string
): Promise<string> {
  return showDataResult({
    titleKey: 'data.exportVault.success.title',
    headerIcon: 'partyPopper',
    tone: 'success',
    location: {
      labelKey: 'data.exportVault.savedTo',
      actionLabelKey: 'data.exportVault.openLocation',
      path: destination
    },
    primaryAction: {
      labelKey: 'data.exportVault.close',
      value: 'close'
    },
    chips: [
      {
        count: report.markdown_written,
        oneKey: 'data.exportVault.chip.notes.one',
        otherKey: 'data.exportVault.chip.notes.other',
        statusKey: 'data.exportVault.chip.notes.status',
        icon: 'fileText',
        tone: 'neutral',
        show: true
      },
      {
        count: report.pdf_written,
        oneKey: 'data.exportVault.chip.pdfs.one',
        otherKey: 'data.exportVault.chip.pdfs.other',
        statusKey: 'data.exportVault.chip.pdfs.status',
        icon: 'fileType',
        tone: 'neutral',
        show: report.pdf_written > 0
      },
      {
        count: report.ink_written,
        oneKey: 'data.exportVault.chip.inkNotes.one',
        otherKey: 'data.exportVault.chip.inkNotes.other',
        statusKey: 'data.exportVault.chip.inkNotes.status',
        icon: 'feather',
        tone: 'neutral',
        show: report.ink_written > 0
      },
      {
        count: report.freeform_written,
        oneKey: 'data.exportVault.chip.diagrams.one',
        otherKey: 'data.exportVault.chip.diagrams.other',
        statusKey: 'data.exportVault.chip.diagrams.status',
        icon: 'pencilRuler',
        tone: 'neutral',
        show: report.freeform_written > 0
      },
      {
        count: report.assets_written,
        oneKey: 'data.exportVault.chip.attachments.one',
        otherKey: 'data.exportVault.chip.attachments.other',
        statusKey: 'data.exportVault.chip.attachments.status',
        icon: 'paperclip',
        tone: 'neutral',
        show: report.assets_written > 0
      },
      {
        count: report.errors,
        oneKey: 'data.exportVault.chip.errors.one',
        otherKey: 'data.exportVault.chip.errors.other',
        statusKey: 'data.exportVault.chip.errors.status',
        icon: 'alertTriangle',
        tone: 'destructive',
        show: report.errors > 0
      }
    ]
  });
}

export function showBackupResult(report: BackupReport): Promise<string> {
  return showDataResult({
    titleKey: 'data.backupNow.success.title',
    headerIcon: 'archive',
    tone: 'success',
    location: {
      labelKey: 'data.backupNow.savedTo',
      actionLabelKey: 'data.backupNow.openLocation',
      path: report.destination,
      openPath: parentPath(report.destination)
    },
    primaryAction: {
      labelKey: 'data.backupNow.close',
      value: 'close'
    },
    chips: [
      notesChip(report.counts.notes, 'data.backupNow.chip.notes.status'),
      foldersChip(report.counts.folders, 'data.backupNow.chip.folders.status'),
      attachmentBytesChip(
        report.counts.assets_bytes,
        'data.backupNow.chip.attachments.status'
      ),
      {
        countTextKey: report.account_present
          ? 'data.backupNow.chip.account.included'
          : 'data.backupNow.chip.account.localOnly',
        labelKey: 'data.backupNow.chip.account.label',
        statusKey: 'data.backupNow.chip.account.status',
        icon: report.account_present ? 'cloud' : 'hardDrive',
        tone: report.account_present ? 'success' : 'warning',
        show: true
      }
    ]
  });
}

export function showMergeResult(report: MergeReport): Promise<string> {
  return showDataResult({
    titleKey: 'data.import.merge.success.title',
    headerIcon: 'gitMerge',
    tone: 'success',
    primaryAction: {
      labelKey: 'data.import.result.close',
      value: 'close'
    },
    chips: [
      notesChip(report.notes_added, 'data.import.merge.chip.notes.status'),
      foldersChip(
        report.folders_added,
        'data.import.merge.chip.folders.status'
      ),
      {
        count: report.assets_added,
        oneKey: 'data.import.merge.chip.attachments.one',
        otherKey: 'data.import.merge.chip.attachments.other',
        statusKey: 'data.import.merge.chip.attachments.status',
        icon: 'paperclip',
        tone: 'neutral',
        show: true
      },
      {
        count: report.notes_orphaned,
        oneKey: 'data.import.merge.chip.orphaned.one',
        otherKey: 'data.import.merge.chip.orphaned.other',
        statusKey: 'data.import.merge.chip.orphaned.status',
        icon: 'alertTriangle',
        tone: report.notes_orphaned > 0 ? 'warning' : 'success',
        show: true
      }
    ]
  });
}

/**
 * Summary for a finished vault import.
 *
 * Link counts are the headline, not the note count: whether a migrated vault
 * is usable comes down to whether its cross-references survived, and that is
 * the one number the user cannot check by eye.
 */
export function showImportResult(report: ImportReport): Promise<string> {
  const clean = report.errors === 0 && !report.cancelled;
  return showDataResult({
    titleKey: report.cancelled
      ? 'data.importNotes.result.stopped.title'
      : 'data.importNotes.result.success.title',
    headerIcon: report.cancelled ? 'alertTriangle' : 'partyPopper',
    tone: clean ? 'success' : 'warning',
    primaryAction: {
      labelKey: 'data.result.close',
      value: 'close'
    },
    chips: [
      notesChip(report.notes_created, 'data.importNotes.chip.notes.status'),
      foldersChip(
        report.folders_created,
        'data.importNotes.chip.folders.status'
      ),
      {
        count: report.links_resolved,
        oneKey: 'data.importNotes.chip.links.one',
        otherKey: 'data.importNotes.chip.links.other',
        statusKey: 'data.importNotes.chip.links.status',
        icon: 'gitMerge',
        tone: 'success',
        show: true
      },
      {
        count: report.links_unresolved,
        oneKey: 'data.importNotes.chip.unresolved.one',
        otherKey: 'data.importNotes.chip.unresolved.other',
        statusKey: 'data.importNotes.chip.unresolved.status',
        icon: 'alertTriangle',
        tone: 'warning',
        show: report.links_unresolved > 0
      },
      {
        count: report.placeholders_created,
        oneKey: 'data.importNotes.chip.placeholders.one',
        otherKey: 'data.importNotes.chip.placeholders.other',
        statusKey: 'data.importNotes.chip.placeholders.status',
        icon: 'feather',
        tone: 'neutral',
        show: report.placeholders_created > 0
      },
      {
        count: report.attachments_imported,
        oneKey: 'data.result.chip.attachments.one',
        otherKey: 'data.result.chip.attachments.other',
        statusKey: 'data.importNotes.chip.attachments.status',
        icon: 'paperclip',
        tone: 'neutral',
        show: report.attachments_imported > 0
      },
      {
        count: report.attachments_deduplicated,
        oneKey: 'data.result.chip.attachments.one',
        otherKey: 'data.result.chip.attachments.other',
        statusKey: 'data.importNotes.chip.deduplicated.status',
        icon: 'hardDrive',
        tone: 'success',
        show: report.attachments_deduplicated > 0
      },
      {
        count: report.attachments_too_large,
        oneKey: 'data.result.chip.attachments.one',
        otherKey: 'data.result.chip.attachments.other',
        statusKey: 'data.importNotes.chip.tooLarge.status',
        icon: 'alertTriangle',
        tone: 'warning',
        show: report.attachments_too_large > 0
      },
      {
        count: report.errors,
        oneKey: 'data.importNotes.chip.errors.one',
        otherKey: 'data.importNotes.chip.errors.other',
        statusKey: 'data.importNotes.chip.errors.status',
        icon: 'alertTriangle',
        tone: 'destructive',
        show: report.errors > 0
      }
    ]
  });
}

export function showRestoreReadyResult(
  preview: ImportPreview,
  staged: RestoreStaged
): Promise<string> {
  return showDataResult({
    titleKey: 'data.import.restart.title',
    descriptionKey: staged.sanitized
      ? 'data.import.result.restoreReady.sanitized'
      : 'data.import.result.restoreReady.preserved',
    headerIcon: 'rotateCcw',
    tone: 'warning',
    primaryAction: {
      labelKey: 'data.import.restart.button',
      value: 'restart'
    },
    secondaryAction: {
      labelKey: 'data.import.restart.later',
      value: 'later',
      variant: 'ghost'
    },
    defaultAction: 'later',
    chips: [
      notesChip(
        preview.backup_counts.notes,
        'data.import.restore.chip.notes.status'
      ),
      foldersChip(
        preview.backup_counts.folders,
        'data.import.restore.chip.folders.status'
      ),
      attachmentBytesChip(
        preview.backup_counts.assets_bytes,
        'data.import.restore.chip.attachments.status'
      ),
      {
        countTextKey: preview.same_account
          ? 'data.import.restore.chip.sync.preserved'
          : 'data.import.restore.chip.sync.reset',
        labelKey: 'data.import.restore.chip.sync.label',
        statusKey: 'data.import.restore.chip.sync.status',
        icon: preview.same_account ? 'cloud' : 'hardDrive',
        tone: preview.same_account ? 'success' : 'warning',
        show: true
      }
    ]
  });
}

function notesChip(count: number, statusKey: string): DataResultChip {
  return {
    count,
    oneKey: 'data.result.chip.notes.one',
    otherKey: 'data.result.chip.notes.other',
    statusKey,
    icon: 'fileText',
    tone: 'neutral',
    show: true
  };
}

function foldersChip(count: number, statusKey: string): DataResultChip {
  return {
    count,
    oneKey: 'data.result.chip.folders.one',
    otherKey: 'data.result.chip.folders.other',
    statusKey,
    icon: 'folder',
    tone: 'neutral',
    show: true
  };
}

function attachmentBytesChip(bytes: number, statusKey: string): DataResultChip {
  return {
    countText: formatBytes(bytes),
    labelKey: 'data.result.chip.attachments.label',
    statusKey,
    icon: 'paperclip',
    tone: 'neutral',
    show: true
  };
}

function parentPath(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash > 0 ? path.slice(0, slash) : path;
}
