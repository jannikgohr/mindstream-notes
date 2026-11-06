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

// Runs once when the dialog that was opened with it closes.
let onClose: (() => void) | null = null;

export function openCollectionShareDialog(
  collectionId: string,
  view: ShareDialogView = 'invite',
  options: { onClose?: () => void } = {}
): void {
  shareDialog.collectionId = collectionId;
  shareDialog.view = view;
  onClose = options.onClose ?? null;
}

export function setShareDialogView(view: ShareDialogView): void {
  shareDialog.view = view;
}

export function closeCollectionShareDialog(): void {
  shareDialog.collectionId = null;
  const closed = onClose;
  onClose = null;
  closed?.();
}
