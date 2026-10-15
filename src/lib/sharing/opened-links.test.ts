import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const takePendingInviteLink = vi.fn();
const listen = vi.fn();
const tauri = vi.hoisted(() => ({ on: true, label: 'main' }));

vi.mock('$lib/api/sharing', () => ({
  takePendingInviteLink: () => takePendingInviteLink()
}));
vi.mock('$lib/api/core', () => ({ isTauri: () => tauri.on }));
vi.mock('$lib/api/events', () => ({
  TauriEventName: { InviteLinkOpened: 'invite-link-opened' },
  listen: (name: string, handler: () => void) => listen(name, handler)
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: tauri.label })
}));

import {
  closeJoinLinkDialog,
  joinLinkDialog,
  openJoinLinkDialog
} from '$lib/components/join-link-dialog.svelte';
import {
  installOpenedInviteLinkBridge,
  showOpenedInviteLink
} from './opened-links';

const LINK = `https://notes.example.com/join/uid1#${'A'.repeat(43)}`;

/** Let the bridge's window probe and what follows it run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  tauri.on = true;
  tauri.label = 'main';
  takePendingInviteLink.mockReset().mockResolvedValue(null);
  listen.mockReset().mockResolvedValue(() => {});
  closeJoinLinkDialog();
});

afterEach(() => {
  closeJoinLinkDialog();
  vi.restoreAllMocks();
});

describe('showing a link that was opened outside the app', () => {
  it('opens the join dialog with the link filled in', async () => {
    takePendingInviteLink.mockResolvedValue(LINK);

    await expect(showOpenedInviteLink()).resolves.toBe(true);
    expect(joinLinkDialog.open).toBe(true);
    expect(joinLinkDialog.link).toBe(LINK);
  });

  it('does nothing when no link waits', async () => {
    await expect(showOpenedInviteLink()).resolves.toBe(false);
    expect(joinLinkDialog.open).toBe(false);
  });

  it('shows nothing that is not an invite link', async () => {
    for (const text of [
      'https://example.com/',
      'mindstream-notes://join?link=x',
      'javascript:alert(1)',
      ''
    ]) {
      takePendingInviteLink.mockResolvedValue(text);
      await expect(showOpenedInviteLink(), text).resolves.toBe(false);
      expect(joinLinkDialog.open, text).toBe(false);
    }
  });

  it('stays quiet when the link cannot be fetched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    takePendingInviteLink.mockRejectedValue(new Error('ipc down'));

    await expect(showOpenedInviteLink()).resolves.toBe(false);
    expect(joinLinkDialog.open).toBe(false);
  });

  it('opens the dialog afresh for a second link', async () => {
    openJoinLinkDialog('something typed by hand');
    const before = joinLinkDialog.opened;
    takePendingInviteLink.mockResolvedValue(LINK);

    await showOpenedInviteLink();

    // The counter is what makes the open dialog start over.
    expect(joinLinkDialog.opened).toBe(before + 1);
    expect(joinLinkDialog.link).toBe(LINK);
    expect(joinLinkDialog.open).toBe(true);
  });
});

describe('listening for links', () => {
  it('shows the link the app was started with and then listens', async () => {
    takePendingInviteLink.mockResolvedValueOnce(LINK);
    const stop = installOpenedInviteLinkBridge();
    await settle();

    expect(joinLinkDialog.link).toBe(LINK);
    expect(listen).toHaveBeenCalledWith(
      'invite-link-opened',
      expect.any(Function)
    );
    stop();
  });

  it('fetches the link when it is told that one arrived', async () => {
    const stop = installOpenedInviteLinkBridge();
    await settle();
    expect(joinLinkDialog.open).toBe(false);

    takePendingInviteLink.mockResolvedValueOnce(LINK);
    const arrived = listen.mock.calls[0][1] as () => void;
    arrived();
    await settle();

    expect(joinLinkDialog.open).toBe(true);
    expect(joinLinkDialog.link).toBe(LINK);
    stop();
  });

  it('leaves the link to the main window', async () => {
    // A window a note was opened in. The link is handed out once, and the
    // main window is the one that is brought to the front.
    tauri.label = 'note_abc';
    takePendingInviteLink.mockResolvedValue(LINK);
    const stop = installOpenedInviteLinkBridge();
    await settle();

    expect(listen).not.toHaveBeenCalled();
    expect(takePendingInviteLink).not.toHaveBeenCalled();
    expect(joinLinkDialog.open).toBe(false);
    stop();
  });

  it('does nothing outside the desktop app', async () => {
    tauri.on = false;
    const stop = installOpenedInviteLinkBridge();
    await settle();

    expect(listen).not.toHaveBeenCalled();
    expect(takePendingInviteLink).not.toHaveBeenCalled();
    stop();
  });

  it('stops listening when it is torn down', async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const stop = installOpenedInviteLinkBridge();
    await settle();

    stop();
    await settle();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
