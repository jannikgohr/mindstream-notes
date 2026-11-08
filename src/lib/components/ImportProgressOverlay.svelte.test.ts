import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

const cancelImport = vi.fn();
vi.mock('$lib/api/notes-import', () => ({
  cancelImport: () => cancelImport()
}));

import ImportProgressOverlay from './ImportProgressOverlay.svelte';
import {
  importActivity,
  importProgressed,
  resetImportActivityForTests
} from '$lib/storage/import-activity.svelte';

beforeEach(() => {
  resetImportActivityForTests();
  cancelImport.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('ImportProgressOverlay', () => {
  it('covers the window while an import runs and shows how far it got', () => {
    render(ImportProgressOverlay);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    importProgressed({ phase: 'importing', done: 500, total: 2000 });
    flushSync();
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'Imported 500 of 2000 notes'
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '25'
    );

    importProgressed({ phase: 'finished', done: 0, total: 0 });
    flushSync();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('stays away where the import dialog shows the progress', () => {
    render(ImportProgressOverlay);
    importActivity.shownByDialog = true;
    importProgressed({ phase: 'scanning', done: 0, total: 0 });
    flushSync();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('stops the import from any window', async () => {
    importProgressed({ phase: 'scanning', done: 0, total: 0 });
    render(ImportProgressOverlay);
    const stop = await screen.findByRole('button', { name: 'Stop' });
    await fireEvent.click(stop);
    expect(cancelImport).toHaveBeenCalledOnce();
    expect((stop as HTMLButtonElement).disabled).toBe(true);
  });
});
