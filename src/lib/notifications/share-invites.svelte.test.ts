import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isTauri, listIncomingShares } = vi.hoisted(() => ({
  isTauri: vi.fn(),
  listIncomingShares: vi.fn()
}));

vi.mock('$lib/api/core', () => ({ isTauri }));
vi.mock('$lib/platform', () => ({ isMobile: vi.fn().mockReturnValue(false) }));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: vi.fn().mockReturnValue(true)
}));
vi.mock('$lib/api/sharing', () => ({ listIncomingShares }));

import {
  notificationState,
  scanForShareInviteNotifications
} from './store.svelte';

function share(overrides: Record<string, unknown> = {}) {
  return {
    invitation_id: 'invite_1',
    collection_uid: 'col_shared',
    name: 'Project X',
    sender_username: 'alice',
    access_level: 'read_write',
    ...overrides
  };
}

beforeEach(() => {
  notificationState.items = [];
  isTauri.mockReset().mockReturnValue(true);
  listIncomingShares.mockReset().mockResolvedValue([]);
});

describe('scanForShareInviteNotifications', () => {
  it('posts one notification per invitation, with the folder name', async () => {
    listIncomingShares.mockResolvedValue([
      share(),
      share({ invitation_id: 'invite_2', name: 'Recipes' })
    ]);

    await scanForShareInviteNotifications();

    expect(notificationState.items).toHaveLength(2);
    const first = notificationState.items.find(
      (item) => item.id === 'share-invite:invite_1'
    );
    expect(first?.kind).toBe('share-invite');
    expect(first?.widgetType).toBe('share-invite');
    expect(first?.data).toEqual({
      invitationId: 'invite_1',
      collectionUid: 'col_shared',
      name: 'Project X',
      senderUsername: 'alice',
      accessLevel: 'read_write'
    });
  });

  it('shows an invitation whose name the server did not send', async () => {
    listIncomingShares.mockResolvedValue([share({ name: null })]);

    await scanForShareInviteNotifications();

    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].data).toMatchObject({
      invitationId: 'invite_1',
      name: null,
      senderUsername: 'alice'
    });
  });

  it('does not post the same invitation twice across scans', async () => {
    listIncomingShares.mockResolvedValue([share()]);

    await scanForShareInviteNotifications();
    await scanForShareInviteNotifications();

    expect(notificationState.items).toHaveLength(1);
  });

  it('drops invitations that no longer wait and keeps other kinds', async () => {
    notificationState.items = [
      {
        id: 'share-invite:invite_gone',
        kind: 'share-invite',
        widgetType: 'share-invite',
        createdAt: 0,
        data: {}
      },
      {
        id: 'update:9.9.9',
        kind: 'update',
        widgetType: 'update',
        createdAt: 0,
        data: {}
      }
    ];
    listIncomingShares.mockResolvedValue([share()]);

    await scanForShareInviteNotifications();

    const ids = notificationState.items.map((item) => item.id).sort();
    expect(ids).toEqual(['share-invite:invite_1', 'update:9.9.9']);
  });

  it('keeps what is shown when the list cannot be fetched', async () => {
    listIncomingShares.mockResolvedValue([share()]);
    await scanForShareInviteNotifications();
    listIncomingShares.mockRejectedValue(new Error('offline'));

    await scanForShareInviteNotifications();

    expect(notificationState.items).toHaveLength(1);
  });

  it('does nothing outside Tauri', async () => {
    isTauri.mockReturnValue(false);
    await scanForShareInviteNotifications();
    expect(listIncomingShares).not.toHaveBeenCalled();
  });
});
