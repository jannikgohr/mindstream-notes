import { beforeEach, describe, expect, it } from 'vitest';
import type { ImportReport } from '$lib/api';
import {
  importNotesQueue,
  openImportDialog
} from './import-notes-dialog.svelte';

const report = (): ImportReport => ({
  notes_created: 2,
  folders_created: 1,
  placeholders_created: 0,
  attachments_imported: 1,
  attachments_deduplicated: 0,
  attachments_too_large: 0,
  links_resolved: 1,
  links_unresolved: 0,
  errors: 0,
  cancelled: false
});

beforeEach(() => {
  importNotesQueue.items = [];
});

describe('openImportDialog', () => {
  it('enqueues a pending import and resolves with its report', async () => {
    const result = openImportDialog();

    expect(importNotesQueue.items).toHaveLength(1);
    importNotesQueue.items[0].resolve(report());

    await expect(result).resolves.toEqual(report());
  });

  it('resolves with null when the user closes without importing', async () => {
    const result = openImportDialog();
    importNotesQueue.items[0].resolve(null);

    await expect(result).resolves.toBeNull();
  });

  it('preserves FIFO order across multiple requests', () => {
    void openImportDialog();
    void openImportDialog();

    expect(importNotesQueue.items).toHaveLength(2);
    expect(importNotesQueue.items[0]).not.toBe(importNotesQueue.items[1]);
  });
});
