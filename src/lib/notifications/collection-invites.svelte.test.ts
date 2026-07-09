import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isTauri, listIncomingShareBundles } = vi.hoisted(() => ({
  isTauri: vi.fn(),
  listIncomingShareBundles: vi.fn()
}));

vi.mock('$lib/api/core', () => ({ isTauri }));
vi.mock('$lib/platform', () => ({ isMobile: vi.fn().mockReturnValue(false) }));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: vi.fn().mockReturnValue(true)
}));
vi.mock('$lib/api/sharing', () => ({ listIncomingShareBundles }));

import {
  notificationState,
  scanForCollectionInviteNotifications
} from './store.svelte';

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    manifest_invitation_id: 'invite_manifest',
    manifest_collection_uid: 'col_manifest',
    pending: false,
    share_scope_id: 'scope_1',
    name: 'Project X',
    root_folder_id: 'folder_root',
    owner_username: 'alice',
    sender_username: 'alice',
    access_level: 'read_write',
    complete: true,
    parts: [],
    warnings: [],
    ...overrides
  };
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite_other',
    username: 'me',
    sender_username: 'bob',
    collection_uid: 'col_other',
    access_level: 'read_only',
    collection_type: 'custom.collection',
    ...overrides
  };
}

beforeEach(() => {
  notificationState.items = [];
  isTauri.mockReset().mockReturnValue(true);
  listIncomingShareBundles
    .mockReset()
    .mockResolvedValue({ bundles: [], unbundled_invitations: [] });
});

describe('scanForCollectionInviteNotifications', () => {
  it('posts one share-bundle notification per manifest bundle', async () => {
    listIncomingShareBundles.mockResolvedValue({
      bundles: [bundle()],
      unbundled_invitations: []
    });

    await scanForCollectionInviteNotifications();

    expect(notificationState.items).toHaveLength(1);
    const item = notificationState.items[0];
    expect(item.id).toBe('share-bundle:col_manifest');
    expect(item.kind).toBe('share-bundle');
    expect(item.data).toMatchObject({
      manifestCollectionUid: 'col_manifest',
      name: 'Project X',
      senderUsername: 'alice',
      accessLevel: 'read_write',
      complete: true
    });
  });

  it('surfaces an unaccepted (pending) share with no name yet', async () => {
    listIncomingShareBundles.mockResolvedValue({
      bundles: [bundle({ pending: true, name: null, share_scope_id: null })],
      unbundled_invitations: []
    });

    await scanForCollectionInviteNotifications();

    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].data).toMatchObject({
      manifestCollectionUid: 'col_manifest',
      pending: true,
      name: null,
      senderUsername: 'alice'
    });
  });

  it('keeps non-manifest invitations as lone collaboration-invites', async () => {
    listIncomingShareBundles.mockResolvedValue({
      bundles: [],
      unbundled_invitations: [invitation()]
    });

    await scanForCollectionInviteNotifications();

    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].id).toBe(
      'collaboration-invite:invite_other'
    );
    expect(notificationState.items[0].kind).toBe('collaboration-invite');
  });

  it('reconciles away accepted/declined shares but preserves other kinds', async () => {
    notificationState.items = [
      {
        id: 'share-bundle:col_gone',
        kind: 'share-bundle',
        widgetType: 'share-bundle',
        createdAt: 0,
        data: {}
      },
      {
        id: 'collaboration-invite:invite_gone',
        kind: 'collaboration-invite',
        widgetType: 'collaboration-invite',
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
    listIncomingShareBundles.mockResolvedValue({
      bundles: [bundle()],
      unbundled_invitations: []
    });

    await scanForCollectionInviteNotifications();

    const ids = notificationState.items.map((item) => item.id).sort();
    expect(ids).toEqual(['share-bundle:col_manifest', 'update:9.9.9']);
  });

  it('does nothing outside Tauri', async () => {
    isTauri.mockReturnValue(false);
    await scanForCollectionInviteNotifications();
    expect(listIncomingShareBundles).not.toHaveBeenCalled();
  });
});
