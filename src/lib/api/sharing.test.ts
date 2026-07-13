import { describe, expect, it } from 'vitest';

import {
  acceptCollectionInvitation,
  acceptShareBundle,
  declineShareBundle,
  getCollectionShareState,
  inviteCollection,
  listCollectionInvitations,
  listIncomingShareBundles,
  rejectCollectionInvitation
} from './sharing';

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
