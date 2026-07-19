/** Which sharing surface is open for the target collection. `invite` is the
 *  add-people dialog; `access` is the manage-members dialog. The two switch
 *  between each other via `setShareDialogView`. */
export type ShareDialogView = 'invite' | 'access';

interface ShareDialogState {
  collectionId: string | null;
  view: ShareDialogView;
}

export const shareDialog = $state<ShareDialogState>({
  collectionId: null,
  view: 'invite'
});

export function openCollectionShareDialog(
  collectionId: string,
  view: ShareDialogView = 'invite'
): void {
  shareDialog.collectionId = collectionId;
  shareDialog.view = view;
}

export function setShareDialogView(view: ShareDialogView): void {
  shareDialog.view = view;
}

export function closeCollectionShareDialog(): void {
  shareDialog.collectionId = null;
}
