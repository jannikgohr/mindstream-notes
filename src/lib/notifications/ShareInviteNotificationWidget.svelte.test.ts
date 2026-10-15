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
  acceptShare: (id: string, options: unknown) => acceptShare(id, options),
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
      senderKey: {
        username: 'alice',
        standing: 'known',
        fingerprint: '11111   22222',
        known_fingerprint: null
      },
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
    expect(acceptShare).toHaveBeenCalledWith('invite_1', {
      trustChangedKey: false
    });
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

  describe('from a key that is not the one remembered', () => {
    const changed = () =>
      invitation({
        senderKey: {
          username: 'alice',
          standing: 'changed',
          fingerprint: '11111   22222',
          known_fingerprint: '33333   44444'
        }
      });

    it('says so and shows both keys', () => {
      render(ShareInviteNotificationWidget, { notification: changed() });

      const warning = screen.getByTestId('share-invite-key-changed');
      expect(warning.textContent).toContain(
        'not the one you accepted from alice before'
      );
      const [now, before] = screen.getAllByTestId('key-fingerprint');
      expect(now.textContent).toBe('11111   22222');
      expect(before.textContent).toBe('33333   44444');
      // Nothing is plainly accepted.
      expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    });

    it('accepts only as a choice to trust the new key', async () => {
      render(ShareInviteNotificationWidget, { notification: changed() });

      await fireEvent.click(
        screen.getByRole('button', { name: 'Accept anyway' })
      );

      await waitFor(() =>
        expect(acceptShare).toHaveBeenCalledWith('invite_1', {
          trustChangedKey: true
        })
      );
    });

    it('can still be declined', async () => {
      render(ShareInviteNotificationWidget, { notification: changed() });

      await fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

      await waitFor(() =>
        expect(declineShare).toHaveBeenCalledWith('invite_1')
      );
      expect(acceptShare).not.toHaveBeenCalled();
    });
  });

  it('shows no warning for a key seen for the first time', () => {
    render(ShareInviteNotificationWidget, {
      notification: invitation({
        senderKey: {
          username: 'alice',
          standing: 'new',
          fingerprint: '11111   22222',
          known_fingerprint: null
        }
      })
    });

    expect(screen.queryByTestId('share-invite-key-changed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('lists the invitations again when the server refuses for a changed key', async () => {
    acceptShare.mockRejectedValue({
      code: 'refused',
      message: 'server words',
      reason: 'key_changed'
    });
    render(ShareInviteNotificationWidget, { notification: invitation() });

    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(
        screen.getByText('Their key is not the one this device remembers.')
      ).toBeTruthy()
    );
    expect(scanForShareInviteNotifications).toHaveBeenCalled();
    expect(dismissNotification).not.toHaveBeenCalled();
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
