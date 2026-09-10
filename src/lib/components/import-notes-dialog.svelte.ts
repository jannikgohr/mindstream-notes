/**
 * Queue + imperative API for the "Import notes" dialog.
 *
 * Mirrors `import-choice-dialog.svelte.ts`: the store lives in a standalone
 * `.svelte.ts` so non-component callers (the Data settings actions) can
 * `await openImportDialog()` without pulling bits-ui into their static graph.
 * The pure logic the dialog renders from is in `import-notes-helpers.ts`.
 */

import type { ImportReport } from '$lib/api';

export interface PendingImport {
  /** Resolves with the report, or `null` if the user backed out. */
  resolve: (report: ImportReport | null) => void;
}

export const importNotesQueue = $state<{ items: PendingImport[] }>({
  items: []
});

/**
 * Open the import dialog and wait for it to finish.
 *
 * Resolves with the report when a run completes — including a cancelled run,
 * which still reports what it managed to write — and with `null` when the user
 * closes the dialog without importing anything.
 */
export function openImportDialog(): Promise<ImportReport | null> {
  return new Promise((resolve) => {
    importNotesQueue.items = [...importNotesQueue.items, { resolve }];
  });
}
