interface ShareDialogState {
  collectionId: string | null;
}

export const shareDialog = $state<ShareDialogState>({
  collectionId: null
});

export function openCollectionShareDialog(collectionId: string): void {
  shareDialog.collectionId = collectionId;
}

export function closeCollectionShareDialog(): void {
  shareDialog.collectionId = null;
}
