import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import {
  acceptCollectionInvitation,
  acceptShareBundle,
  declineShareBundle,
  getCollectionShareState,
  inviteCollection,
  leaveSharedCollection,
  listCollectionInvitations,
  listCollectionMembers,
  listIncomingShareBundles,
  rejectCollectionInvitation,
  removeCollectionMember,
  setCollectionMemberAccess,
  stopSharingCollection
} from './sharing';

function setTauri(on: boolean): void {
  if (on)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

const INVITATION = {
  id: 'inv1',
  username: 'alice',
  sender_username: 'bob',
  collection_uid: 'col-uid',
  access_level: 'read_write',
  collection_type: 'notes'
};

const SHARE_STATE = {
  collection_id: 'folder_1',
  share_id: 'share-1',
  shared_role: 'admin',
  shared_owner: 'bob',
  shared_by_me: true,
  members: [{ username: 'alice', access_level: 'read_only' }],
  outgoing_invitations: [INVITATION]
};

describe('sharing API fallback (non-Tauri)', () => {
  it('returns empty incoming invitation views', async () => {
    await expect(listCollectionInvitations()).resolves.toEqual([]);
    await expect(listIncomingShareBundles()).resolves.toEqual({
      bundles: [],
      unbundled_invitations: []
    });
  });

  it('resolves accept and decline commands as no-ops', async () => {
    await expect(acceptShareBundle('manifest_uid')).resolves.toBeUndefined();
    await expect(declineShareBundle('manifest_uid')).resolves.toBeUndefined();
    await expect(
      acceptCollectionInvitation('invite_1')
    ).resolves.toBeUndefined();
    await expect(
      rejectCollectionInvitation('invite_2')
    ).resolves.toBeUndefined();
  });

  it('reports collection sharing as unavailable outside Tauri', async () => {
    await expect(
      inviteCollection({
        collection_id: 'folder_1',
        username: 'recipient',
        access_level: 'read_write'
      })
    ).rejects.toThrow(
      'Collection sharing is only available in the Tauri desktop app.'
    );
  });

  it('resolves the share-lifecycle commands as no-ops', async () => {
    await expect(leaveSharedCollection('folder_1')).resolves.toBeUndefined();
    await expect(stopSharingCollection('folder_1')).resolves.toBeUndefined();
  });

  it('reports no members and accepts member edits as no-ops', async () => {
    // The manage-access dialog renders straight off these, so the fallback has
    // to be an empty roster rather than a rejection.
    await expect(listCollectionMembers('folder_1')).resolves.toEqual([]);
    await expect(
      setCollectionMemberAccess({
        collection_id: 'folder_1',
        username: 'recipient',
        access_level: 'read_only'
      })
    ).resolves.toBeUndefined();
    await expect(
      removeCollectionMember({
        collection_id: 'folder_1',
        username: 'recipient'
      })
    ).resolves.toBeUndefined();
  });

  it('returns an unshared default collection state outside Tauri', async () => {
    await expect(getCollectionShareState('folder_1')).resolves.toEqual({
      collection_id: 'folder_1',
      share_id: null,
      shared_role: null,
      shared_owner: null,
      shared_by_me: false,
      members: [],
      outgoing_invitations: []
    });
  });
});

describe('sharing API — input validation (synchronous)', () => {
  it('rejects empty required-string arguments', () => {
    expect(() => acceptShareBundle('')).toThrow(/must be a non-empty string/);
    expect(() => declineShareBundle('  ')).toThrow(
      /must be a non-empty string/
    );
    expect(() => leaveSharedCollection('')).toThrow(/must be a non-empty/);
    expect(() => stopSharingCollection('')).toThrow(/must be a non-empty/);
    expect(() => listCollectionMembers('')).toThrow(/must be a non-empty/);
    expect(() => acceptCollectionInvitation('')).toThrow(/must be a non-empty/);
    expect(() => rejectCollectionInvitation('')).toThrow(/must be a non-empty/);
    expect(() => getCollectionShareState('')).toThrow(/must be a non-empty/);
  });

  it('rejects an unknown access level up front', () => {
    expect(() =>
      setCollectionMemberAccess({
        collection_id: 'c',
        username: 'u',
        access_level: 'root' as never
      })
    ).toThrow(/unknown access level/);
    expect(() =>
      inviteCollection({
        collection_id: 'c',
        username: 'u',
        access_level: 'root' as never
      })
    ).toThrow(/unknown access level/);
  });

  it('rejects an empty member/invite identifier', () => {
    expect(() =>
      removeCollectionMember({ collection_id: '', username: 'u' })
    ).toThrow(/must be a non-empty/);
  });
});

describe('sharing API — Tauri parse path', () => {
  beforeEach(() => {
    setTauri(true);
    invoke.mockReset();
  });
  afterEach(() => setTauri(false));

  it('parses collection invitations and rejects non-arrays', async () => {
    invoke.mockResolvedValueOnce([INVITATION]);
    const invitations = await listCollectionInvitations();
    expect(invitations[0]).toEqual(INVITATION);
    invoke.mockResolvedValueOnce({});
    await expect(listCollectionInvitations()).rejects.toThrow(
      /must be an array/
    );
  });

  it('rejects an invitation with an unknown access level', async () => {
    invoke.mockResolvedValue([{ ...INVITATION, access_level: 'super' }]);
    await expect(listCollectionInvitations()).rejects.toThrow(
      /unknown access level/
    );
  });

  it('parses an incoming share bundle with parts and a nested invitation', async () => {
    invoke.mockResolvedValue({
      bundles: [
        {
          manifest_invitation_id: 'm1',
          manifest_collection_uid: 'muid',
          pending: false,
          share_scope_id: 'scope-1',
          name: 'Team folder',
          root_folder_id: 'root-1',
          owner_username: 'bob',
          sender_username: 'bob',
          access_level: 'read_only',
          complete: true,
          parts: [
            {
              part: 'folders',
              collection_uid: 'c1',
              expected_collection_type: 'notes',
              required: true,
              invitation: INVITATION
            },
            {
              part: 'assets',
              collection_uid: null,
              expected_collection_type: 'assets',
              required: false,
              invitation: null
            }
          ],
          warnings: ['w1']
        }
      ],
      unbundled_invitations: [INVITATION]
    });
    const view = await listIncomingShareBundles();
    expect(view.bundles).toHaveLength(1);
    expect(view.bundles[0].parts[0].part).toBe('folders');
    expect(view.bundles[0].parts[0].invitation?.id).toBe('inv1');
    expect(view.bundles[0].parts[1].invitation).toBeNull();
    expect(view.bundles[0].access_level).toBe('read_only');
    expect(view.unbundled_invitations).toHaveLength(1);
  });

  it('rejects a bundle part with an unknown share part', async () => {
    invoke.mockResolvedValue({
      bundles: [
        {
          manifest_invitation_id: 'm1',
          manifest_collection_uid: 'muid',
          pending: true,
          share_scope_id: null,
          name: null,
          root_folder_id: null,
          owner_username: null,
          sender_username: null,
          access_level: null,
          complete: false,
          parts: [
            {
              part: 'nonsense',
              collection_uid: null,
              expected_collection_type: 'notes',
              required: true,
              invitation: null
            }
          ],
          warnings: []
        }
      ],
      unbundled_invitations: []
    });
    await expect(listIncomingShareBundles()).rejects.toThrow(
      /unknown share part/
    );
  });

  it('parses full share state (members + invitations + nullable role)', async () => {
    invoke.mockResolvedValue(SHARE_STATE);
    const state = await getCollectionShareState('folder_1');
    expect(state.shared_role).toBe('admin');
    expect(state.members[0].username).toBe('alice');
    expect(state.outgoing_invitations[0].id).toBe('inv1');
  });

  it('inviteCollection parses the returned share state', async () => {
    invoke.mockResolvedValue({ ...SHARE_STATE, shared_role: null });
    const state = await inviteCollection({
      collection_id: 'folder_1',
      username: 'alice',
      access_level: 'read_write'
    });
    expect(state.shared_role).toBeNull();
  });

  it('listCollectionMembers parses members and rejects a bad access level', async () => {
    invoke.mockResolvedValueOnce([
      { username: 'alice', access_level: 'admin' }
    ]);
    await expect(listCollectionMembers('folder_1')).resolves.toHaveLength(1);
    invoke.mockResolvedValueOnce([{ username: 'x', access_level: 'wat' }]);
    await expect(listCollectionMembers('folder_1')).rejects.toThrow(
      /unknown access level/
    );
  });
});
