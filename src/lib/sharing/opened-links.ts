/**
 * Invite links opened outside the app.
 *
 * A link clicked in a browser reaches the app through the operating system:
 * the Rust side takes it in, keeps it, and says that one arrived (see
 * `deep_links.rs`). This is the window's half. It fetches the link and opens
 * the dialog for joining a shared folder with the link filled in.
 *
 * It does no more than that. Any program on the device can hand the app an
 * address with any link inside, so nothing is asked of a server until the
 * user goes on in the dialog.
 */
import { isTauri } from '$lib/api/core';
import { listen, TauriEventName } from '$lib/api/events';
import { takePendingInviteLink } from '$lib/api/sharing';
import { openJoinLinkDialog } from '$lib/components/join-link-dialog.svelte';
import { parseInviteLink } from './invite-link';

/**
 * Show the invite link the operating system handed the app, if one waits.
 * Resolves to whether the dialog was opened.
 */
export async function showOpenedInviteLink(): Promise<boolean> {
  let link: string | null;
  try {
    link = await takePendingInviteLink();
  } catch (err) {
    console.warn('[deep-link] could not fetch the link that was opened', err);
    return false;
  }
  // The Rust side only keeps what the client library takes for an invite
  // link. Checked here as well, because what goes into the dialog comes
  // from outside the app.
  if (link === null || parseInviteLink(link) === null) return false;
  openJoinLinkDialog(link);
  return true;
}

/** Whether this is the app's main window, and not one a note was opened in. */
async function isMainWindow(): Promise<boolean> {
  try {
    const { getCurrentWebviewWindow } =
      await import('@tauri-apps/api/webviewWindow');
    return getCurrentWebviewWindow().label === 'main';
  } catch (err) {
    console.warn('[deep-link] window label probe unavailable', err);
    return false;
  }
}

/**
 * Listen for invite links opened outside the app, and show the one the app
 * was started with, if it was. Installed once from the root layout. Only
 * the main window answers: the Rust side brings that one to the front, and
 * a link is there to be taken once.
 */
export function installOpenedInviteLinkBridge(): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let unlisten: Promise<() => void> | null = null;
  void isMainWindow().then((main) => {
    if (!main || stopped) return;
    unlisten = listen(TauriEventName.InviteLinkOpened, () => {
      void showOpenedInviteLink();
    });
    // Started by a link: it arrived before this window was there to hear.
    void showOpenedInviteLink();
  });
  return () => {
    stopped = true;
    void unlisten?.then((stop) => stop());
  };
}
