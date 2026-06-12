/**
 * Queue + imperative API for the export-result dialog. Same shape as
 * `confirm-dialog.svelte.ts` — a `.svelte.ts` file with no bits-ui
 * imports so non-component callers (settings actions) can pop the
 * dialog without dragging the bits-ui re-export chain into their
 * static module graph.
 *
 * The dialog itself (`ExportResultDialog.svelte`) is mounted once in
 * the root layout and consumes this queue.
 */

import type { ExportReport } from '$lib/notes-export';

export interface PendingExportResult {
  report: ExportReport;
  destination: string;
  resolve: () => void;
}

export const exportResultQueue = $state<{ items: PendingExportResult[] }>({
  items: []
});

export function showExportResult(
  report: ExportReport,
  destination: string
): Promise<void> {
  return new Promise((resolve) => {
    exportResultQueue.items = [
      ...exportResultQueue.items,
      { report, destination, resolve }
    ];
  });
}
