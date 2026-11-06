import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tree } from '$lib/stores/tree.svelte';
import { shareNewFolder } from './new-shared-folder';
import { closeCollectionShareDialog, shareDialog } from './share-dialog.svelte';
import { toasts } from './toast.svelte';

const KEPT =
  "“Team” wasn't shared, so it stays in Home. Share it from its menu when you're ready.";

beforeEach(() => {
  toasts.items.splice(0);
  tree.collectionsById.team = {
    id: 'team',
    name: 'Team',
    parent_collection_id: null
  } as (typeof tree.collectionsById)[string];
});

afterEach(() => {
  closeCollectionShareDialog();
  delete tree.collectionsById.team;
});

describe('sharing a new folder', () => {
  it('opens the invite dialog on the folder', () => {
    shareNewFolder('team', 'Team');
    expect(shareDialog.collectionId).toBe('team');
    expect(shareDialog.view).toBe('invite');
    expect(toasts.items).toHaveLength(0);
  });

  it('says the folder stayed in Home when the dialog closes unshared', () => {
    shareNewFolder('team', 'Team');
    closeCollectionShareDialog();
    expect(toasts.items.map((toast) => toast.message)).toEqual([KEPT]);
  });

  it('says nothing once someone was invited', () => {
    shareNewFolder('team', 'Team');
    tree.collectionsById.team.shared_by_me = true;
    closeCollectionShareDialog();
    expect(toasts.items).toHaveLength(0);
  });

  it('forgets the folder once another dialog opens', async () => {
    shareNewFolder('team', 'Team');
    const { openCollectionShareDialog } = await import('./share-dialog.svelte');
    openCollectionShareDialog('other');
    closeCollectionShareDialog();
    expect(toasts.items).toHaveLength(0);
  });
});
