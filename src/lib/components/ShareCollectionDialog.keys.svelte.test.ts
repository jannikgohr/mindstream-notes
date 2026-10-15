/**
 * What the invite dialog does when the recipient's key is not the one this
 * device remembers: nothing is sent, the change is shown, and the user can
 * send it after looking. The dialog's other paths are in
 * ShareCollectionDialog.svelte.test.ts, which runs without a backend.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandErrorCode } from '$lib/api/core';

const inviteCollection = vi.fn();
const userKeyInfo = vi.fn();
const loadTree = vi.fn();
const pushToast = vi.fn();

vi.mock('$lib/api/sharing', () => ({
  inviteCollection: (input: unknown) => inviteCollection(input),
  userKeyInfo: (username: string) => userKeyInfo(username)
}));
vi.mock('$lib/stores/tree.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/tree.svelte')>()),
  loadTree: () => loadTree()
}));
vi.mock('./toast.svelte', () => ({
  pushToast: (message: string, options: unknown) => pushToast(message, options)
}));

import ShareCollectionDialog from './ShareCollectionDialog.svelte';
import {
  closeCollectionShareDialog,
  openCollectionShareDialog
} from './share-dialog.svelte';

const KEY_CHANGED = {
  code: CommandErrorCode.Refused,
  message: 'the key of bob is not the one this device remembers',
  reason: 'key_changed'
};

async function invite(names: string) {
  await fireEvent.input(screen.getByRole('textbox'), {
    target: { value: names }
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
}

beforeEach(() => {
  inviteCollection.mockReset();
  userKeyInfo.mockReset().mockResolvedValue({
    username: 'bob',
    standing: 'changed',
    fingerprint: '11111   22222',
    known_fingerprint: '33333   44444'
  });
  loadTree.mockReset().mockResolvedValue(undefined);
  pushToast.mockReset();
  openCollectionShareDialog('folder_work');
});

afterEach(() => {
  cleanup();
  closeCollectionShareDialog();
});

describe('inviting someone whose key changed', () => {
  it('sends nothing on its own and shows what changed', async () => {
    inviteCollection.mockRejectedValue(KEY_CHANGED);
    render(ShareCollectionDialog);
    await invite('bob');

    expect(await screen.findByTestId('key-changed-notice')).toBeTruthy();
    expect(inviteCollection).toHaveBeenCalledOnce();
    expect(inviteCollection.mock.calls[0][0].trust_changed_key).toBeUndefined();
    await waitFor(() =>
      expect(screen.getAllByTestId('key-fingerprint')).toHaveLength(2)
    );
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('sends it once the user says to share with the new key', async () => {
    inviteCollection
      .mockRejectedValueOnce(KEY_CHANGED)
      .mockResolvedValueOnce({});
    render(ShareCollectionDialog);
    await invite('bob');
    await screen.findAllByTestId('key-fingerprint');

    await fireEvent.click(
      screen.getByRole('button', { name: 'Share with the new key' })
    );

    await waitFor(() => expect(inviteCollection).toHaveBeenCalledTimes(2));
    expect(inviteCollection.mock.calls[1][0]).toEqual({
      collection_id: 'folder_work',
      username: 'bob',
      access_level: 'read_write',
      trust_changed_key: true
    });
    await waitFor(() =>
      expect(screen.queryByTestId('key-changed-notice')).toBeNull()
    );
    expect(pushToast).toHaveBeenCalledWith('Invited bob', {
      variant: 'success'
    });
    // Nothing is left to retry.
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('keeps the others apart: one invited, one held back', async () => {
    inviteCollection.mockImplementation(async (input: { username: string }) => {
      if (input.username === 'bob') throw KEY_CHANGED;
      return {};
    });
    render(ShareCollectionDialog);
    await invite('alice, bob');

    expect(await screen.findByTestId('key-changed-notice')).toBeTruthy();
    expect(pushToast).toHaveBeenCalledWith('Invited alice', {
      variant: 'success'
    });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('bob');
  });

  it('shows another failure the usual way', async () => {
    inviteCollection.mockRejectedValue(new Error('no such user'));
    render(ShareCollectionDialog);
    await invite('bob');

    expect(await screen.findByText(/no such user/)).toBeTruthy();
    expect(screen.queryByTestId('key-changed-notice')).toBeNull();
    expect(userKeyInfo).not.toHaveBeenCalled();
  });

  it('says why when sending with the new key fails too', async () => {
    inviteCollection
      .mockRejectedValueOnce(KEY_CHANGED)
      .mockRejectedValueOnce(new Error('offline'));
    render(ShareCollectionDialog);
    await invite('bob');
    await screen.findAllByTestId('key-fingerprint');

    await fireEvent.click(
      screen.getByRole('button', { name: 'Share with the new key' })
    );

    expect(await screen.findByText(/offline/)).toBeTruthy();
    expect(screen.queryByTestId('key-changed-notice')).toBeNull();
  });
});
