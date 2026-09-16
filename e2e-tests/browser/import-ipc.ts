import type { Page } from '@playwright/test';
import type {
  ImportOptions,
  ImportReport
} from '../../src/lib/api/notes-import';

type ImportTest = {
  runs: ImportOptions[];
  fail: () => void;
  complete: (cancelled?: boolean) => void;
};

/** Only the native boundary is stubbed; dialogs, settings, and focus are real. */
export async function installImportIpc(
  page: Page,
  instant = false
): Promise<void> {
  await page.evaluate((instant) => {
    const host = window as unknown as {
      __TAURI_INTERNALS__?: {
        transformCallback: () => number;
        invoke: (
          command: string,
          args?: { options: ImportOptions }
        ) => Promise<unknown>;
      };
      __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: () => void };
      __importTest: ImportTest;
    };
    let callbackId = 0;
    let resolveRun: ((report: ImportReport) => void) | undefined;
    let rejectRun: ((error: Error) => void) | undefined;
    host.__importTest = {
      runs: [],
      fail: () => {
        if (!rejectRun) throw new Error('No import is running');
        rejectRun(new Error('Import failed for test'));
        resolveRun = undefined;
        rejectRun = undefined;
      },
      complete: (cancelled = false) => {
        if (!resolveRun) throw new Error('No import is running');
        resolveRun({
          notes_created: 2,
          folders_created: 1,
          placeholders_created: 0,
          attachments_imported: 0,
          attachments_deduplicated: 0,
          attachments_too_large: 0,
          links_resolved: 0,
          links_unresolved: 0,
          errors: 0,
          cancelled
        });
        resolveRun = undefined;
        rejectRun = undefined;
      }
    };
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callbackId,
      invoke: async (command, args) => {
        switch (command) {
          case 'plugin:event|listen':
            return ++callbackId;
          case 'plugin:event|unlisten':
            return;
          case 'notes_import_pick_folder':
            return '/test/vault';
          case 'notes_import_detect':
            return {
              path: '/test/vault',
              kind: 'obsidian',
              suggested_name: 'Vault'
            };
          case 'notes_import_run':
            if (!args) throw new Error('Missing import options');
            host.__importTest.runs.push(args.options);
            return new Promise<ImportReport>((resolve, reject) => {
              resolveRun = resolve;
              rejectRun = reject;
              if (instant) host.__importTest.complete();
            });
          case 'notes_import_cancel':
            return;
          // Completion refreshes the tree; this fixture does not write notes.
          // Persistence is checked by the packaged-app test, not this stub.
          case 'list_notes':
          case 'list_collections':
            return [];
          default:
            throw new Error(`Unexpected test IPC: ${command}`);
        }
      }
    };
  }, instant);
}

export async function failImport(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __importTest: ImportTest }).__importTest.fail()
  );
}

export async function completeImport(
  page: Page,
  cancelled = false
): Promise<void> {
  await page.evaluate(
    (cancelled) =>
      (window as unknown as { __importTest: ImportTest }).__importTest.complete(
        cancelled
      ),
    cancelled
  );
}

export async function importRuns(page: Page): Promise<ImportOptions[]> {
  return page.evaluate(
    () => (window as unknown as { __importTest: ImportTest }).__importTest.runs
  );
}
