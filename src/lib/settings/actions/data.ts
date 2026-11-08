/**
 * Action handlers for the "Data" settings section: open the vault folder,
 * empty trash, backup / restore, export / import. Wired into the schema
 * via `actionId` and surfaced through `SETTING_ACTIONS` in registry.svelte.
 *
 * Kept separate so the registry stays a thin wiring file — these handlers
 * own all the picker / confirm / toast choreography for the data section.
 */

import { tick } from 'svelte';
import { isMobile } from '$lib/platform';
import { restartToApply } from '$lib/app-restart';
import {
  pickBrowserSaveFile,
  type BrowserSaveFile
} from '$lib/api/file-export';
import { vaultArchiveName } from '$lib/notes-export/archive-name';
import {
  backupNow,
  convertLegacyWikilinks,
  importBegin,
  importCleanup,
  importMerge,
  importRestore,
  legacyWikilinkCount,
  isTauri,
  openDataFolder,
  pickExportDir,
  trashCounts
} from '$lib/api';
import {
  emptyTrash as emptyTrashStore,
  loadTree
} from '$lib/stores/tree.svelte';
import { pickImportChoice } from '$lib/components/import-choice-dialog.svelte';
import { alert, confirm } from '$lib/components/confirm-dialog.svelte';
import {
  showBackupResult,
  showExportResult,
  showImportResult,
  showMergeResult,
  showRestoreReadyResult
} from '$lib/components/export-result-dialog.svelte';
import { openImportDialog } from '$lib/components/import-notes-dialog.svelte';
import { tUi } from '../i18n.svelte';
import { toErrorMessage } from '$lib/api/errors';

export const DATA_ACTIONS: Record<string, () => void | Promise<void>> = {
  'open-data-folder': async () => {
    try {
      await openDataFolder();
    } catch (err) {
      console.error('[settings] open-data-folder failed', err);
      await alert({
        title: tUi('data.openFolder.failed.title'),
        message: tUi('data.openFolder.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    }
  },
  'empty-trash': async () => {
    // Ask Rust for an authoritative count first — the file tree only
    // knows about direct children of the trash collection, but the
    // backend also catches notes nested inside trashed folders. The
    // confirm dialog needs the full damage.
    let counts;
    try {
      counts = await trashCounts();
    } catch (err) {
      console.error('[settings] trash_counts failed', err);
      await alert({
        title: tUi('data.emptyTrash.failed.title'),
        message: tUi('data.emptyTrash.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
      return;
    }
    if (counts.notes === 0 && counts.folders === 0) {
      await alert({
        title: tUi('data.emptyTrash.alreadyEmpty.title'),
        message: tUi('data.emptyTrash.alreadyEmpty.message')
      });
      return;
    }
    const ok = await confirm({
      title: tUi('data.emptyTrash.confirm.title'),
      message: tUi('data.emptyTrash.confirm.message')
        .replace('{notes}', String(counts.notes))
        .replace('{folders}', String(counts.folders)),
      confirmLabel: tUi('data.emptyTrash.confirm.button'),
      destructive: true
    });
    if (!ok) return;
    try {
      // Routes through the store so the file tree refetches and any
      // open Trash view rerenders. Same transactional purge as a
      // direct invoke('empty_trash') would do.
      await emptyTrashStore();
    } catch (err) {
      console.error('[settings] empty_trash failed', err);
      await alert({
        title: tUi('data.emptyTrash.failed.title'),
        message: tUi('data.emptyTrash.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    }
  },
  'backup-now': async () => {
    try {
      const { flushPendingEditorSaves } =
        await import('$lib/editor/suspend-flush');
      await flushPendingEditorSaves();
      const report = await backupNow();
      if (report === null) {
        // User cancelled the Save-As dialog — stay quiet, no toast.
        return;
      }
      await showBackupResult(report);
    } catch (err) {
      console.error('[settings] backup-now failed', err);
      await alert({
        title: tUi('data.backupNow.failed.title'),
        message: tUi('data.backupNow.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    }
  },
  'export-vault': async () => {
    const folderExport = isTauri() && !isMobile();
    let root: string | null = null;
    // A browser with a save picker streams the archive to disk. Ask first,
    // while the click still counts as the gesture the picker requires.
    let browserFile: BrowserSaveFile | null | undefined;
    try {
      if (folderExport) root = await pickExportDir();
      else if (!isTauri()) {
        browserFile = await pickBrowserSaveFile({
          suggestedName: vaultArchiveName(),
          description: tUi('data.exportVault.saveDialog.filter'),
          mime: 'application/zip',
          extension: '.zip'
        });
      }
    } catch (err) {
      console.error('[settings] export-vault picker failed', err);
      await alert({
        title: tUi('data.exportVault.failed.title'),
        message: tUi('data.exportVault.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
      return;
    }
    if ((folderExport && !root) || browserFile === null) {
      // User cancelled the folder or save picker — stay quiet.
      return;
    }
    try {
      // `notes-export` pulls in the Excalidraw dep through its freeform
      // branch — keep it out of the static module graph so tests for
      // unrelated modules don't trip over Excalidraw's roughjs resolution.
      const { flushPendingEditorSaves } =
        await import('$lib/editor/suspend-flush');
      await flushPendingEditorSaves();
      const {
        downloadVaultExport,
        exportVaultToFolder,
        saveVaultArchive,
        streamVaultExport
      } = await import('$lib/notes-export');
      const destination = root;
      const picked = browserFile;
      // From here on the stream owns the picked file and discards it itself.
      browserFile = undefined;
      const report =
        destination !== null
          ? await exportVaultToFolder(destination)
          : isTauri()
            ? await saveVaultArchive()
            : picked
              ? await streamVaultExport(picked)
              : await downloadVaultExport();
      if (report === null) return;
      await showExportResult(report, destination);
    } catch (err) {
      // Failed before the stream took the picked file over: discard it here.
      await browserFile?.abort();
      console.error('[settings] export-vault failed', err);
      await alert({
        title: tUi('data.exportVault.failed.title'),
        message: tUi('data.exportVault.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    }
  },
  'import-notes': async () => {
    // The dialog owns the whole flow — picking a source, detecting its
    // format, and running the import — because it has to render progress
    // while the run is in flight. It resolves with the report, or null if
    // the user backed out before starting.
    const trigger = document.activeElement;
    try {
      const report = await openImportDialog();
      if (report === null) return;
      // Imported notes and folders are only in SQLite so far; the tree store
      // is what the file explorer renders from.
      await loadTree();
      await showImportResult(report);
    } finally {
      // The result replaces the importer, whose focused controls are removed.
      // Restore the workflow's original trigger after the last dialog unmounts.
      await tick();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    }
  },
  'convert-legacy-links': async () => {
    let count: number;
    try {
      count = await legacyWikilinkCount();
    } catch (err) {
      console.error('[settings] legacy_wikilink_count failed', err);
      await alert({
        title: tUi('data.convertLegacyLinks.failed.title'),
        message: tUi('data.convertLegacyLinks.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
      return;
    }
    if (count === 0) {
      await alert({
        title: tUi('data.convertLegacyLinks.none.title'),
        message: tUi('data.convertLegacyLinks.none.message')
      });
      return;
    }
    // Ask first: this rewrites note bodies, and each rewrite is a CRDT edit
    // that syncs like any other change.
    const ok = await confirm({
      title: tUi('data.convertLegacyLinks.confirm.title'),
      message: tUi('data.convertLegacyLinks.confirm.message').replace(
        '{count}',
        String(count)
      ),
      confirmLabel: tUi('data.convertLegacyLinks.confirm.button')
    });
    if (!ok) return;
    try {
      const report = await convertLegacyWikilinks();
      if (report === null) return;
      await loadTree();
      await alert({
        title: tUi('data.convertLegacyLinks.done.title'),
        message: tUi('data.convertLegacyLinks.done.message')
          .replace('{links}', String(report.links_converted))
          .replace('{notes}', String(report.notes_converted))
          .replace('{unresolved}', String(report.links_unresolved))
      });
    } catch (err) {
      console.error('[settings] convert_legacy_wikilinks failed', err);
      await alert({
        title: tUi('data.convertLegacyLinks.failed.title'),
        message: tUi('data.convertLegacyLinks.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    }
  },
  'restore-backup': async () => {
    let preview;
    try {
      preview = await importBegin();
    } catch (err) {
      console.error('[settings] import_begin failed', err);
      await alert({
        title: tUi('data.import.failed.title'),
        message: tUi('data.import.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
      return;
    }
    if (preview === null) {
      // User cancelled the file picker — stay quiet.
      return;
    }
    const options = { includeDevice: false };
    const choice = await pickImportChoice(preview, options);
    if (choice === 'cancel') {
      await importCleanup(preview.token).catch((err) =>
        console.warn('[settings] import_cleanup failed', err)
      );
      return;
    }
    if (choice === 'merge') {
      try {
        const report = await importMerge(preview.token);
        await loadTree();
        await showMergeResult(report);
      } catch (err) {
        console.error('[settings] import_merge failed', err);
        await alert({
          title: tUi('data.import.failed.title'),
          message: tUi('data.import.failed.message').replace(
            '{error}',
            toErrorMessage(err)
          )
        });
      }
      return;
    }
    // Restore path — destructive. Re-confirm before staging.
    const confirmed = await confirm({
      title: tUi('data.import.restore.confirm.title'),
      message: !isTauri()
        ? tUi('data.import.restore.confirm.browser')
        : preview.same_account
          ? tUi('data.import.restore.confirm.sameAccount')
          : tUi('data.import.restore.confirm.differentAccount'),
      confirmLabel: tUi('data.import.restore.confirm.button'),
      destructive: true
    });
    if (!confirmed) {
      await importCleanup(preview.token).catch((err) =>
        console.warn('[settings] import_cleanup failed', err)
      );
      return;
    }
    try {
      // A browser's safety backup has to hold the latest edits.
      const { flushPendingEditorSaves } =
        await import('$lib/editor/suspend-flush');
      await flushPendingEditorSaves();
      const staged = await importRestore(
        preview.token,
        preview.same_account,
        options.includeDevice,
        () =>
          confirm({
            title: tUi('data.import.restore.safety.title'),
            message: tUi('data.import.restore.safety.message'),
            confirmLabel: tUi('data.import.restore.safety.button'),
            destructive: true
          })
      );
      if (!staged) {
        await importCleanup(preview.token).catch((err) =>
          console.warn('[settings] import_cleanup failed', err)
        );
        return;
      }
      if (staged.restart_required) {
        const action = await showRestoreReadyResult(preview, staged);
        // The restore is already staged here, so a failed restart is not a
        // failed import: the next launch swaps the backup in either way.
        if (action === 'restart' && !(await restartToApply())) {
          await alert({
            title: tUi('data.import.restart.manual.title'),
            message: tUi('data.import.restart.manual.message')
          });
        }
      } else if (!isTauri()) {
        window.location.reload();
      }
    } catch (err) {
      console.error('[settings] import_restore failed', err);
      await alert({
        title: tUi('data.import.failed.title'),
        message: tUi('data.import.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    }
  },
  'clear-cache': () => {
    console.info('[settings] action: clear-cache (stub)');
  }
};
