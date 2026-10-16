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
export interface ImportOptions {
  includeDevice: boolean;
}

export interface PendingImportChoice {
  preview: ImportPreview;
  options: ImportOptions;
  resolve: (choice: ImportChoice, includeDevice?: boolean) => void;
}

export const importChoiceQueue = $state<{ items: PendingImportChoice[] }>({
  items: []
});

/**
 * Pop the import-choice dialog and await the user's pick. Returns
 * `'cancel'` if the user closes the dialog with Escape / outside-tap.
 */
export function pickImportChoice(
  preview: ImportPreview,
  options: ImportOptions = { includeDevice: false }
): Promise<ImportChoice> {
  return new Promise((resolve) => {
    importChoiceQueue.items = [
      ...importChoiceQueue.items,
      {
        preview,
        resolve: (choice, includeDevice = false) => {
          options.includeDevice = includeDevice;
          resolve(choice);
        },
        options
      }
    ];
  });
}
