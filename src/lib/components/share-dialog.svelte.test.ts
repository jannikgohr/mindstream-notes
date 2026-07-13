import { describe, expect, it } from 'vitest';

import {
  closeCollectionShareDialog,
  openCollectionShareDialog,
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
});
