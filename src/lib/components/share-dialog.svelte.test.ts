import { describe, expect, it } from 'vitest';

import {
  closeCollectionShareDialog,
  openCollectionShareDialog,
  setShareDialogView,
  shareDialog
} from './share-dialog.svelte';

describe('share dialog state', () => {
  it('opens for a collection and closes back to idle', () => {
    closeCollectionShareDialog();
    expect(shareDialog.collectionId).toBeNull();

    openCollectionShareDialog('folder_1');
    expect(shareDialog.collectionId).toBe('folder_1');

    closeCollectionShareDialog();
    expect(shareDialog.collectionId).toBeNull();
  });

  it('opens on the invite view and switches to manage access', () => {
    openCollectionShareDialog('folder_1');
    expect(shareDialog.view).toBe('invite');

    setShareDialogView('access');
    expect(shareDialog.view).toBe('access');

    closeCollectionShareDialog();
  });

  it('opens straight into the requested view', () => {
    openCollectionShareDialog('folder_1', 'access');
    expect(shareDialog.view).toBe('access');

    // Re-opening for another folder resets to the invite view.
    openCollectionShareDialog('folder_2');
    expect(shareDialog.collectionId).toBe('folder_2');
    expect(shareDialog.view).toBe('invite');

    closeCollectionShareDialog();
  });
});
