/** Whether the dialog for joining a shared folder by an invite link is open,
 *  and the link it opens with, if it was opened with one. */
interface JoinLinkDialogState {
  open: boolean;
  link: string;
  /** Counts how often the dialog was opened. A link that arrives from
   *  outside while the dialog is open opens it afresh, so that it shows
   *  the new link and nothing it found out about the old one. */
  opened: number;
}

export const joinLinkDialog = $state<JoinLinkDialogState>({
  open: false,
  link: '',
  opened: 0
});

export function openJoinLinkDialog(link = ''): void {
  joinLinkDialog.link = link;
  joinLinkDialog.opened += 1;
  joinLinkDialog.open = true;
}

export function closeJoinLinkDialog(): void {
  joinLinkDialog.open = false;
  joinLinkDialog.link = '';
}
