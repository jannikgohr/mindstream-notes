import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification, ShareInviteNotificationData } from './types';

const acceptShare = vi.fn();
const declineShare = vi.fn();
const runSync = vi.fn();
const dismissNotification = vi.fn();
const scanForShareInviteNotifications = vi.fn();

vi.mock('$lib/api/sharing', () => ({
  acceptShare: (id: string) => acceptShare(id),
  declineShare: (id: string) => declineShare(id)
}));
vi.mock('$lib/sync/runner', () => ({ runSync: () => runSync() }));
vi.mock('./store.svelte', () => ({
  dismissNotification: (id: string) => dismissNotification(id),
  scanForShareInviteNotifications: () => scanForShareInviteNotifications()
}));

import ShareInviteNotificationWidget from './ShareInviteNotificationWidget.svelte';

function invitation(
  over: Partial<ShareInviteNotificationData> = {}
): AppNotification<ShareInviteNotificationData> {
  return {
    id: 'share-invite:invite_1',
    kind: 'share-invite',
    widgetType: 'share-invite',
    createdAt: 0,
    data: {
      invitationId: 'invite_1',
      collectionUid: 'col_shared',
      name: 'Trip plans',
      senderUsername: 'alice',
      accessLevel: 'read_write',
      ...over
    }
  };
}

beforeEach(() => {
  acceptShare.mockReset().mockResolvedValue(undefined);
  declineShare.mockReset().mockResolvedValue(undefined);
  runSync.mockReset().mockResolvedValue({});
  dismissNotification.mockReset();
  scanForShareInviteNotifications.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('ShareInviteNotificationWidget', () => {
  it('names the folder and who shared it before anything is accepted', () => {
    render(ShareInviteNotificationWidget, { notification: invitation() });

    expect(screen.getByText('alice shared “Trip plans” with you')).toBeTruthy();
    expect(screen.getByText('Can edit')).toBeTruthy();
    expect(acceptShare).not.toHaveBeenCalled();
  });

  it('still offers an invitation that came without a name or a sender', () => {
    render(ShareInviteNotificationWidget, {
      notification: invitation({
        name: null,
        senderUsername: null,
        accessLevel: 'read_only'
      })
    });

    expect(
      screen.getByText('Someone wants to share a folder with you')
    ).toBeTruthy();
    expect(screen.getByText('Can view')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('accepts by invitation id, then asks for the sync that brings the folder', async () => {
    const onClose = vi.fn();
    render(ShareInviteNotificationWidget, {
      notification: invitation(),
      onClose
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(acceptShare).toHaveBeenCalledWith('invite_1');
    expect(dismissNotification).toHaveBeenCalledWith('share-invite:invite_1');
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(scanForShareInviteNotifications).toHaveBeenCalled();
  });

  it('keeps the invitation and says why when accepting fails', async () => {
    acceptShare.mockRejectedValue(new Error('the server said no'));
    render(ShareInviteNotificationWidget, { notification: invitation() });

    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(screen.getByText(/the server said no/)).toBeTruthy()
    );
    expect(dismissNotification).not.toHaveBeenCalled();
    expect(runSync).not.toHaveBeenCalled();
    // And it can be tried again.
    expect(
      (screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it('declines by invitation id and syncs nothing', async () => {
    render(ShareInviteNotificationWidget, { notification: invitation() });

    await fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() =>
      expect(dismissNotification).toHaveBeenCalledWith('share-invite:invite_1')
    );
    expect(declineShare).toHaveBeenCalledWith('invite_1');
    expect(acceptShare).not.toHaveBeenCalled();
    expect(runSync).not.toHaveBeenCalled();
  });
});
