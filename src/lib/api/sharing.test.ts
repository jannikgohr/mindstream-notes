import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import {
  acceptShare,
  claimShareLink,
  createShareLink,
  declineShare,
  getCollectionShareState,
  inviteCollection,
  leaveSharedCollection,
  listCollectionMembers,
  listIncomingShares,
  listShareLinks,
  openShareLink,
  ownKeyFingerprint,
  removeCollectionMember,
  revokeShareLink,
  setCollectionMemberAccess,
  stopSharingCollection,
  userKeyInfo
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
  access_level: 'read_write',
  sender_key: null
};

const SENDER_KEY = {
  username: 'bob',
  standing: 'changed',
  fingerprint: '11111   22222',
  known_fingerprint: '33333   44444'
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

  it('reads the sender key that comes with an invitation', async () => {
    invoke.mockResolvedValueOnce([
      { ...INCOMING_SHARE, sender_key: SENDER_KEY }
    ]);
    const [share] = await listIncomingShares();
    expect(share.sender_key).toEqual(SENDER_KEY);

    // A key that was not seen before has no other one to show.
    invoke.mockResolvedValueOnce([
      {
        ...INCOMING_SHARE,
        sender_key: { ...SENDER_KEY, standing: 'new', known_fingerprint: null }
      }
    ]);
    const [fresh] = await listIncomingShares();
    expect(fresh.sender_key?.standing).toBe('new');
    expect(fresh.sender_key?.known_fingerprint).toBeNull();
  });

  it('rejects a sender key it cannot place', async () => {
    invoke.mockResolvedValueOnce([
      { ...INCOMING_SHARE, sender_key: { ...SENDER_KEY, standing: 'fine' } }
    ]);
    await expect(listIncomingShares()).rejects.toThrow(/standing/);
    invoke.mockResolvedValueOnce([
      { ...INCOMING_SHARE, sender_key: { ...SENDER_KEY, fingerprint: 7 } }
    ]);
    await expect(listIncomingShares()).rejects.toThrow(/fingerprint/);
  });

  it('answers an invitation by its id', async () => {
    invoke.mockResolvedValue(null);
    await acceptShare('inv1');
    expect(invoke).toHaveBeenLastCalledWith('accept_share', {
      invitationId: 'inv1',
      trustChangedKey: false
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

describe('invite links', () => {
  const LINK = `https://notes.example.test/join/link_1#${'A'.repeat(43)}`;
  const SHARE_LINK = {
    uid: 'link_1',
    access_level: 'read_only',
    max_uses: 5,
    uses: 2,
    allows_signup: true,
    expires_at: 1_900_000_000,
    created_at: 1_899_000_000,
    sender_username: 'ann'
  };
  const PREVIEW = {
    server_url: 'https://notes.example.test/',
    collection_uid: 'col_1',
    name: null,
    sender_username: 'ann',
    access_level: 'read_write',
    can_signup: true,
    signed_in: false,
    already_member: false
  };

  describe('outside Tauri', () => {
    it('has no links and removes none', async () => {
      await expect(listShareLinks('folder_1')).resolves.toEqual([]);
      await expect(revokeShareLink('link_1')).resolves.toBeUndefined();
    });

    it('cannot make, open or claim one', async () => {
      const unavailable =
        'Collection sharing is only available in the Tauri desktop app.';
      await expect(
        createShareLink({
          collection_id: 'folder_1',
          access_level: 'read_only'
        })
      ).rejects.toThrow(unavailable);
      await expect(openShareLink(LINK)).rejects.toThrow(unavailable);
      await expect(claimShareLink(LINK)).rejects.toThrow(unavailable);
    });
  });

  it('refuses bad input before asking anything', () => {
    expect(() => listShareLinks('')).toThrow(/must be a non-empty/);
    expect(() => revokeShareLink(' ')).toThrow(/must be a non-empty/);
    expect(() => openShareLink('')).toThrow(/must be a non-empty/);
    expect(() => claimShareLink('')).toThrow(/must be a non-empty/);
    expect(() =>
      createShareLink({ collection_id: '', access_level: 'read_only' })
    ).toThrow(/must be a non-empty/);
    // A link never makes someone an admin.
    expect(() =>
      createShareLink({
        collection_id: 'folder_1',
        access_level: 'admin' as never
      })
    ).toThrow(/view or edit/);
  });

  describe('in Tauri', () => {
    beforeEach(() => {
      setTauri(true);
      invoke.mockReset();
    });
    afterEach(() => setTauri(false));

    it('makes a link with what was chosen', async () => {
      invoke.mockResolvedValue({ link: LINK, uid: 'link_1' });
      const input = {
        collection_id: 'folder_1',
        access_level: 'read_write' as const,
        max_uses: 5,
        expires_in_days: 30,
        allow_signup: true
      };

      await expect(createShareLink(input)).resolves.toEqual({
        link: LINK,
        uid: 'link_1'
      });
      expect(invoke).toHaveBeenCalledWith('create_share_link', { input });
    });

    it('rejects a made link that has no text', async () => {
      invoke.mockResolvedValue({ uid: 'link_1' });
      await expect(
        createShareLink({
          collection_id: 'folder_1',
          access_level: 'read_only'
        })
      ).rejects.toThrow(/created share link\.link/);
    });

    it('lists the links of a folder', async () => {
      invoke.mockResolvedValue([SHARE_LINK]);

      await expect(listShareLinks('folder_1')).resolves.toEqual([SHARE_LINK]);
      expect(invoke).toHaveBeenCalledWith('list_share_links', {
        collectionId: 'folder_1'
      });
    });

    it('rejects a list it cannot read', async () => {
      invoke.mockResolvedValueOnce({ links: [] });
      await expect(listShareLinks('folder_1')).rejects.toThrow(/an array/);
      invoke.mockResolvedValueOnce([{ ...SHARE_LINK, uses: '2' }]);
      await expect(listShareLinks('folder_1')).rejects.toThrow(
        /share link\.uses must be a number/
      );
      invoke.mockResolvedValueOnce([{ ...SHARE_LINK, access_level: 'root' }]);
      await expect(listShareLinks('folder_1')).rejects.toThrow(
        /unknown access level/
      );
    });

    it('removes a link by its uid', async () => {
      invoke.mockResolvedValue(null);

      await expect(revokeShareLink('link_1')).resolves.toBeUndefined();
      expect(invoke).toHaveBeenCalledWith('revoke_share_link', {
        uid: 'link_1'
      });
    });

    it('reads what a link leads to, a folder without a name included', async () => {
      invoke.mockResolvedValue(PREVIEW);

      await expect(openShareLink(LINK)).resolves.toEqual(PREVIEW);
      expect(invoke).toHaveBeenCalledWith('open_share_link', { link: LINK });
    });

    it('rejects a preview that leaves out whether one can join', async () => {
      const { signed_in: _signedIn, ...rest } = PREVIEW;
      invoke.mockResolvedValue(rest);
      await expect(openShareLink(LINK)).rejects.toThrow(
        /share link preview\.signed_in/
      );
    });

    it('claims a link', async () => {
      invoke.mockResolvedValue(null);

      await expect(claimShareLink(LINK)).resolves.toBeUndefined();
      expect(invoke).toHaveBeenCalledWith('claim_share_link', { link: LINK });
    });
  });
});

describe('the keys of the people shared with', () => {
  const KEY = {
    username: 'bob',
    standing: 'changed',
    fingerprint: '11111   22222',
    known_fingerprint: '33333   44444'
  };

  it('cannot be asked about outside Tauri', async () => {
    await expect(userKeyInfo('bob')).rejects.toThrow(/Tauri desktop app/);
    await expect(ownKeyFingerprint()).rejects.toThrow(/Tauri desktop app/);
  });

  it('needs a name to ask about', () => {
    expect(() => userKeyInfo(' ')).toThrow(/must be a non-empty/);
  });

  describe('in Tauri', () => {
    beforeEach(() => {
      setTauri(true);
      invoke.mockReset();
    });
    afterEach(() => setTauri(false));

    it('reads how a user key stands', async () => {
      invoke.mockResolvedValue(KEY);

      await expect(userKeyInfo('bob')).resolves.toEqual(KEY);
      expect(invoke).toHaveBeenCalledWith('user_key_info', { username: 'bob' });
    });

    it('rejects a key it cannot read', async () => {
      invoke.mockResolvedValueOnce({ ...KEY, standing: 'maybe' });
      await expect(userKeyInfo('bob')).rejects.toThrow(/standing/);
      invoke.mockResolvedValueOnce({ ...KEY, username: null });
      await expect(userKeyInfo('bob')).rejects.toThrow(/username/);
    });

    it('reads the account key as digits', async () => {
      invoke.mockResolvedValue('45680   71497');

      await expect(ownKeyFingerprint()).resolves.toBe('45680   71497');
      expect(invoke).toHaveBeenCalledWith('own_key_fingerprint', undefined);
      invoke.mockResolvedValue({ digits: 1 });
      await expect(ownKeyFingerprint()).rejects.toThrow(/must be a string/);
    });

    it('says when the user chose to trust a changed key', async () => {
      invoke.mockResolvedValue(null);

      await acceptShare('inv1', { trustChangedKey: true });
      expect(invoke).toHaveBeenLastCalledWith('accept_share', {
        invitationId: 'inv1',
        trustChangedKey: true
      });
    });

    it('passes the choice along with an invitation that is sent', async () => {
      invoke.mockResolvedValue({
        collection_id: 'folder_1',
        share_id: 'share-1',
        shared_role: null,
        shared_owner: 'ann',
        shared_by_me: true,
        members: [],
        outgoing_invitations: []
      });
      const input = {
        collection_id: 'folder_1',
        username: 'bob',
        access_level: 'read_write' as const,
        trust_changed_key: true
      };

      await inviteCollection(input);
      expect(invoke).toHaveBeenCalledWith('invite_collection', { input });
    });
  });
});
