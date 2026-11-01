/**
 * Who gets to see the invite links of a folder. The members list and the
 * links themselves are covered by the T4 sharing specs and by the links
 * section's own test. What is decided here is only whether the section is
 * there at all.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionShareState } from '$lib/api/sharing';

const getCollectionShareState = vi.fn();
const listCollectionMembers = vi.fn();
const listShareLinks = vi.fn();
const accountServerInfo = vi.fn();
const removeCollectionMember = vi.fn();
const revokeShareLink = vi.fn();
const confirm = vi.fn();

vi.mock('$lib/api/sharing', () => ({
  createShareLink: vi.fn(),
  getCollectionShareState: (id: string) => getCollectionShareState(id),
  listCollectionMembers: (id: string) => listCollectionMembers(id),
  listShareLinks: (id: string) => listShareLinks(id),
  removeCollectionMember: (input: unknown) => removeCollectionMember(input),
  revokeShareLink: (uid: string) => revokeShareLink(uid),
  setCollectionMemberAccess: vi.fn()
}));
vi.mock('./confirm-dialog.svelte', () => ({
  confirm: (options: unknown) => confirm(options)
}));
vi.mock('$lib/api/account', () => ({
  accountServerInfo: (target: unknown) => accountServerInfo(target)
}));

import { authSession } from '$lib/api/auth.svelte';
import ManageAccessDialog from './ManageAccessDialog.svelte';
import {
  closeCollectionShareDialog,
  openCollectionShareDialog
} from './share-dialog.svelte';

function shareState(
  over: Partial<CollectionShareState> = {}
): CollectionShareState {
  return {
    collection_id: 'folder_1',
    share_id: null,
    shared_role: null,
    shared_owner: null,
    shared_by_me: false,
    members: [],
    outgoing_invitations: [],
    ...over
  };
}

/** Open the dialog on a folder in the given state and wait for it to load. */
async function open(state: CollectionShareState) {
  getCollectionShareState.mockResolvedValue(state);
  openCollectionShareDialog('folder_1', 'access');
  render(ManageAccessDialog);
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
}

beforeEach(() => {
  getCollectionShareState.mockReset();
  listCollectionMembers.mockReset().mockResolvedValue([]);
  listShareLinks.mockReset().mockResolvedValue([]);
  accountServerInfo.mockReset().mockResolvedValue({
    signup: 'closed',
    protocol: 1,
    version: '0.1.0'
  });
  authSession.current = {
    username: 'ann',
    server_url: 'https://notes.example.test/'
  };
});

afterEach(() => {
  cleanup();
  closeCollectionShareDialog();
  authSession.current = null;
});

describe('the invite links of a folder', () => {
  it('are offered for a folder that is not shared yet', async () => {
    await open(shareState());

    expect(await screen.findByTestId('share-links')).toBeTruthy();
    expect(listShareLinks).toHaveBeenCalledWith('folder_1');
  });

  it('are offered to the one who shares the folder', async () => {
    await open(shareState({ share_id: 'scope_1', shared_by_me: true }));

    expect(await screen.findByTestId('share-links')).toBeTruthy();
  });

  it('are offered to an admin of the folder', async () => {
    await open(
      shareState({
        share_id: 'scope_1',
        shared_role: 'admin',
        shared_owner: 'bob'
      })
    );

    expect(await screen.findByTestId('share-links')).toBeTruthy();
  });

  it('are kept from members who only view or edit', async () => {
    for (const role of ['read_only', 'read_write'] as const) {
      await open(
        shareState({
          share_id: 'scope_1',
          shared_role: role,
          shared_owner: 'bob'
        })
      );

      expect(screen.queryByTestId('share-links'), role).toBeNull();
      cleanup();
      closeCollectionShareDialog();
    }
    expect(listShareLinks).not.toHaveBeenCalled();
  });

  it('are not offered while the folder could not be read', async () => {
    getCollectionShareState.mockRejectedValue(new Error('offline'));
    openCollectionShareDialog('folder_1', 'access');
    render(ManageAccessDialog);

    expect(await screen.findByText("Couldn't load members.")).toBeTruthy();
    expect(screen.queryByTestId('share-links')).toBeNull();
  });
});

describe('links that create an account', () => {
  it('are offered where the server takes signups by invitation', async () => {
    accountServerInfo.mockResolvedValue({
      signup: 'invite',
      protocol: 1,
      version: '0.1.0'
    });
    await open(shareState({ share_id: 'scope_1', shared_by_me: true }));

    expect(await screen.findByRole('checkbox')).toBeTruthy();
    expect(accountServerInfo).toHaveBeenCalledWith({
      serverType: expect.any(String),
      serverUrl: 'https://notes.example.test/'
    });
  });

  it('are not offered anywhere else, or when the server cannot be asked', async () => {
    await open(shareState({ share_id: 'scope_1', shared_by_me: true }));
    await screen.findByTestId('share-links');
    await waitFor(() => expect(accountServerInfo).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox')).toBeNull();

    cleanup();
    closeCollectionShareDialog();
    accountServerInfo.mockRejectedValue(new Error('offline'));
    await open(shareState({ share_id: 'scope_1', shared_by_me: true }));
    await screen.findByTestId('share-links');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('removing someone from a folder with invite links', () => {
  const link = (uid: string, uses: number, max_uses: number) => ({
    uid,
    access_level: 'read_only',
    max_uses,
    uses,
    allows_signup: false,
    expires_at: 2_000_000_000,
    created_at: 1_000_000_000,
    sender_username: 'me'
  });

  async function removeBob(links: unknown[]) {
    listShareLinks.mockResolvedValue(links);
    listCollectionMembers.mockResolvedValue([
      { username: 'bob', access_level: 'read_only' }
    ]);
    await open(shareState({ share_id: 'scope_1', shared_by_me: true }));
    const remove = await screen.findByRole('button', { name: 'Remove' });
    await fireEvent.click(remove);
    await waitFor(() => expect(removeCollectionMember).toHaveBeenCalled());
  }

  beforeEach(() => {
    removeCollectionMember.mockReset().mockResolvedValue(undefined);
    revokeShareLink.mockReset().mockResolvedValue(undefined);
    confirm.mockReset().mockResolvedValue(true);
  });

  it('offers to revoke the links that can still be used, and only those', async () => {
    await removeBob([link('open', 1, 5), link('spent', 1, 1)]);

    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('open'));
    expect(revokeShareLink).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Revoke open links?',
        message: expect.stringContaining('1 open invite link. bob')
      })
    );
    // The section below shows what is left.
    await waitFor(() => expect(listShareLinks.mock.calls.length).toBe(3));
  });

  it('leaves the links alone when the admin keeps them', async () => {
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await removeBob([link('open', 0, 5)]);

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(revokeShareLink).not.toHaveBeenCalled();
  });

  it('asks nothing when no link can be used any more', async () => {
    await removeBob([link('spent', 1, 1)]);

    await waitFor(() => expect(listShareLinks.mock.calls.length).toBe(2));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
