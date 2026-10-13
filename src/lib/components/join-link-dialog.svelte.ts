/** Whether the dialog for joining a shared folder by an invite link is open,
 *  and the link it opens with, if it was opened with one. */
interface JoinLinkDialogState {
  open: boolean;
  link: string;
}

export const joinLinkDialog = $state<JoinLinkDialogState>({
  open: false,
  link: ''
});

export function openJoinLinkDialog(link = ''): void {
  joinLinkDialog.link = link;
  joinLinkDialog.open = true;
}

export function closeJoinLinkDialog(): void {
  joinLinkDialog.open = false;
  joinLinkDialog.link = '';
}
