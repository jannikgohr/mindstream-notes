/**
 * The last step of the Shared view's "New shared folder": open the Share
 * dialog on the folder just created.
 *
 * The folder only moves into the Shared view once someone is invited, by
 * name or by link. Until then it is a plain folder in Home, so if the dialog
 * closes first, a toast says where the folder went. Both ways of inviting
 * reload the tree, which is what marks the folder as shared by you.
 */

import { tUiFormat } from '$lib/settings/i18n.svelte';
import { collectionIsSharedByMe } from '$lib/stores/note-source.svelte';
import { tree } from '$lib/stores/tree.svelte';
import { openCollectionShareDialog } from './share-dialog.svelte';
import { pushToast } from './toast.svelte';

export function shareNewFolder(id: string, name: string): void {
  openCollectionShareDialog(id, 'invite', {
    onClose: () => {
      const folder = tree.collectionsById[id];
      if (folder && !collectionIsSharedByMe(folder)) {
        pushToast(tUiFormat('sharing.newFolder.keptInHome', { name }));
      }
    }
  });
}
