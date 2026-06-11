/**
 * Queue + imperative API for the three-way import-choice dialog.
 *
 * Mirrors `confirm-dialog.svelte.ts`: lives in a standalone `.svelte.ts`
 * file so non-component callers (registry.svelte.ts) can `await
 * pickImportChoice(...)` without dragging bits-ui's re-export chain into
 * their static graph. The component (`ImportChoiceDialog.svelte`) reads
 * the queue and renders the head of it.
 */

import type { ImportPreview } from '$lib/api';

export type ImportChoice = 'restore' | 'merge' | 'cancel';

export interface PendingImportChoice {
  preview: ImportPreview;
  resolve: (choice: ImportChoice) => void;
}

export const importChoiceQueue = $state<{ items: PendingImportChoice[] }>({
  items: []
});

/**
 * Pop the import-choice dialog and await the user's pick. Returns
 * `'cancel'` if the user closes the dialog with Escape / outside-tap.
 */
export function pickImportChoice(
  preview: ImportPreview
): Promise<ImportChoice> {
  return new Promise((resolve) => {
    importChoiceQueue.items = [
      ...importChoiceQueue.items,
      { preview, resolve }
    ];
  });
}
