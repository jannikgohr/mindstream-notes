/**
 * Action handlers for the "Data" settings section: open the vault folder,
 * empty trash, backup / restore, export / import. Wired into the schema
 * via `actionId` and surfaced through `SETTING_ACTIONS` in registry.svelte.
 *
 * Kept separate so the registry stays a thin wiring file — these handlers
 * own all the picker / confirm / toast choreography for the data section.
 */

import {
  backupNow,
  importBegin,
  importCleanup,
  importMerge,
  importRestore,
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
import { tUi } from '../i18n.svelte';

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
          String(err)
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
          String(err)
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
          String(err)
        )
      });
    }
  },
  'backup-now': async () => {
    try {
      const report = await backupNow();
      if (report === null) {
        // User cancelled the Save-As dialog — stay quiet, no toast.
        return;
      }
      await alert({
        title: tUi('data.backupNow.success.title'),
        message: tUi('data.backupNow.success.message')
          .replace('{notes}', String(report.counts.notes))
          .replace('{folders}', String(report.counts.folders))
          .replace('{destination}', report.destination)
      });
    } catch (err) {
      console.error('[settings] backup-now failed', err);
      await alert({
        title: tUi('data.backupNow.failed.title'),
        message: tUi('data.backupNow.failed.message').replace(
          '{error}',
          String(err)
        )
      });
    }
  },
  'export-vault': async () => {
    let root: string | null;
    try {
      root = await pickExportDir();
    } catch (err) {
      console.error('[settings] export-vault picker failed', err);
      await alert({
        title: tUi('data.exportVault.failed.title'),
        message: tUi('data.exportVault.failed.message').replace(
          '{error}',
          String(err)
        )
      });
      return;
    }
    if (!root) {
      // User cancelled the folder picker — stay quiet.
      return;
    }
    try {
      // `notes-export` pulls in the Excalidraw dep through its freeform
      // branch — keep it out of the static module graph so tests for
      // unrelated modules don't trip over Excalidraw's roughjs resolution.
      const { exportVault } = await import('$lib/notes-export');
      const report = await exportVault(root);
      await alert({
        title: tUi('data.exportVault.success.title'),
        message: tUi('data.exportVault.success.message')
          .replace('{notes}', String(report.notes_written))
          .replace('{folders}', String(report.folders_written))
          .replace('{assets}', String(report.assets_written))
          .replace('{skippedInk}', String(report.skipped_ink))
          .replace('{errors}', String(report.errors))
          .replace('{destination}', root)
      });
    } catch (err) {
      console.error('[settings] export-vault failed', err);
      await alert({
        title: tUi('data.exportVault.failed.title'),
        message: tUi('data.exportVault.failed.message').replace(
          '{error}',
          String(err)
        )
      });
    }
  },
  'import-notes': () => {
    // No logic yet — placeholder for the upcoming "import markdown /
    // Obsidian / external sources" flow. The settings-dialog button
    // is wired through this action so the button at least renders
    // without throwing; replace with the real implementation when
    // that slice lands.
    console.info('[settings] action: import-notes (stub, not yet wired)');
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
          String(err)
        )
      });
      return;
    }
    if (preview === null) {
      // User cancelled the file picker — stay quiet.
      return;
    }
    const choice = await pickImportChoice(preview);
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
        await alert({
          title: tUi('data.import.merge.success.title'),
          message: tUi('data.import.merge.success.message')
            .replace('{notes}', String(report.notes_added))
            .replace('{folders}', String(report.folders_added))
            .replace('{assets}', String(report.assets_added))
            .replace('{orphaned}', String(report.notes_orphaned))
        });
      } catch (err) {
        console.error('[settings] import_merge failed', err);
        await alert({
          title: tUi('data.import.failed.title'),
          message: tUi('data.import.failed.message').replace(
            '{error}',
            String(err)
          )
        });
      }
      return;
    }
    // Restore path — destructive. Re-confirm before staging.
    const confirmed = await confirm({
      title: tUi('data.import.restore.confirm.title'),
      message: preview.same_account
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
      const staged = await importRestore(preview.token, preview.same_account);
      if (staged.restart_required) {
        const restart = await confirm({
          title: tUi('data.import.restart.title'),
          message: tUi('data.import.restart.message'),
          confirmLabel: tUi('data.import.restart.button'),
          cancelLabel: tUi('data.import.restart.later')
        });
        if (restart) {
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        }
      }
    } catch (err) {
      console.error('[settings] import_restore failed', err);
      await alert({
        title: tUi('data.import.failed.title'),
        message: tUi('data.import.failed.message').replace(
          '{error}',
          String(err)
        )
      });
    }
  },
  'clear-cache': () => {
    console.info('[settings] action: clear-cache (stub)');
  }
};
