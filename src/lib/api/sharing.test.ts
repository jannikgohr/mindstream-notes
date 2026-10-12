import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import {
  acceptShare,
  declineShare,
  getCollectionShareState,
  inviteCollection,
  leaveSharedCollection,
  listCollectionMembers,
  listIncomingShares,
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

const INCOMING_SHARE = {
  invitation_id: 'inv1',
  collection_uid: 'col-uid',
  name: 'Team folder',
  sender_username: 'bob',
  access_level: 'read_write'
};

const OUTGOING_INVITATION = {
  id: 'inv2',
  username: 'alice',
  access_level: 'read_only'
};

const SHARE_STATE = {
  collection_id: 'folder_1',
  share_id: 'share-1',
  shared_role: 'admin',
  shared_owner: 'bob',
  shared_by_me: true,
  members: [{ username: 'alice', access_level: 'read_only' }],
  outgoing_invitations: [OUTGOING_INVITATION]
};

describe('sharing API fallback (non-Tauri)', () => {
  it('has no invitations waiting', async () => {
    await expect(listIncomingShares()).resolves.toEqual([]);
  });

  it('resolves accept and decline commands as no-ops', async () => {
    await expect(acceptShare('invite_1')).resolves.toBeUndefined();
    await expect(declineShare('invite_2')).resolves.toBeUndefined();
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
    expect(() => acceptShare('')).toThrow(/must be a non-empty string/);
    expect(() => declineShare('  ')).toThrow(/must be a non-empty string/);
    expect(() => leaveSharedCollection('')).toThrow(/must be a non-empty/);
    expect(() => stopSharingCollection('')).toThrow(/must be a non-empty/);
    expect(() => listCollectionMembers('')).toThrow(/must be a non-empty/);
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

  it('parses incoming shares and rejects non-arrays', async () => {
    invoke.mockResolvedValueOnce([INCOMING_SHARE]);
    await expect(listIncomingShares()).resolves.toEqual([INCOMING_SHARE]);
    invoke.mockResolvedValueOnce({});
    await expect(listIncomingShares()).rejects.toThrow(/must be an array/);
  });

  it('accepts an incoming share whose name the server did not send', async () => {
    invoke.mockResolvedValue([
      { ...INCOMING_SHARE, name: null, sender_username: null }
    ]);
    const [share] = await listIncomingShares();
    expect(share.name).toBeNull();
    expect(share.sender_username).toBeNull();
  });

  it('rejects an incoming share with an unknown access level', async () => {
    invoke.mockResolvedValue([{ ...INCOMING_SHARE, access_level: 'super' }]);
    await expect(listIncomingShares()).rejects.toThrow(/unknown access level/);
  });

  it('answers an invitation by its id', async () => {
    invoke.mockResolvedValue(null);
    await acceptShare('inv1');
    expect(invoke).toHaveBeenLastCalledWith('accept_share', {
      invitationId: 'inv1'
    });
    await declineShare('inv1');
    expect(invoke).toHaveBeenLastCalledWith('decline_share', {
      invitationId: 'inv1'
    });
  });

  it('parses full share state (members + invitations + nullable role)', async () => {
    invoke.mockResolvedValue(SHARE_STATE);
    const state = await getCollectionShareState('folder_1');
    expect(state.shared_role).toBe('admin');
    expect(state.members[0].username).toBe('alice');
    expect(state.outgoing_invitations[0]).toEqual(OUTGOING_INVITATION);
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
