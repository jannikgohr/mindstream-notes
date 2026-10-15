import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandErrorCode } from '$lib/api/core';
import type { ShareLinkPreview } from '$lib/api/sharing';

const openShareLink = vi.fn();
const claimShareLink = vi.fn();
const runSync = vi.fn();
const pushToast = vi.fn();

vi.mock('$lib/api/sharing', () => ({
  claimShareLink: (link: string) => claimShareLink(link),
  openShareLink: (link: string) => openShareLink(link)
}));
vi.mock('$lib/sync/runner', () => ({ runSync: () => runSync() }));
vi.mock('./toast.svelte', () => ({
  pushToast: (message: string, options: unknown) => pushToast(message, options)
}));

import JoinSharedFolderDialog from './JoinSharedFolderDialog.svelte';
import {
  closeJoinLinkDialog,
  joinLinkDialog,
  openJoinLinkDialog
} from './join-link-dialog.svelte';

const LINK = `https://notes.example.test/join/link_1#${'A'.repeat(43)}`;

function preview(over: Partial<ShareLinkPreview> = {}): ShareLinkPreview {
  return {
    server_url: 'https://notes.example.test/',
    collection_uid: 'col_1',
    name: 'Trip plans',
    sender_username: 'ann',
    access_level: 'read_write',
    can_signup: false,
    signed_in: true,
    already_member: false,
    ...over
  };
}

function refused(reason: string) {
  return { code: CommandErrorCode.Refused, message: 'server words', reason };
}

const button = (name: string) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

async function paste(text: string) {
  await fireEvent.input(screen.getByLabelText('Invite link'), {
    target: { value: text }
  });
}

/** Paste a link and look at it. */
async function look(text = LINK) {
  await paste(text);
  await fireEvent.click(button('Continue'));
  await waitFor(() => expect(openShareLink).toHaveBeenCalled());
}

beforeEach(() => {
  openShareLink.mockReset().mockResolvedValue(preview());
  claimShareLink.mockReset().mockResolvedValue(undefined);
  runSync.mockReset().mockResolvedValue(undefined);
  pushToast.mockReset();
  openJoinLinkDialog();
});

afterEach(() => {
  cleanup();
  closeJoinLinkDialog();
});

describe('looking at a link', () => {
  it('waits for something that has the shape of a link', async () => {
    render(JoinSharedFolderDialog);
    expect(button('Continue').disabled).toBe(true);

    await paste('ABCD-EFGH');
    expect(button('Continue').disabled).toBe(true);

    await paste(`  ${LINK}  `);
    expect(button('Continue').disabled).toBe(false);
  });

  it('shows who invites to what before anything is joined', async () => {
    render(JoinSharedFolderDialog);
    await look(`  ${LINK}  `);

    const shown = await screen.findByTestId('join-link-preview');
    expect(openShareLink).toHaveBeenCalledWith(LINK);
    expect(shown.textContent).toContain('ann invites you to “Trip plans”');
    expect(shown.textContent).toContain('Can edit');
    expect(shown.textContent).toContain('notes.example.test');
    expect(claimShareLink).not.toHaveBeenCalled();
  });

  it('opens with the link it was given', () => {
    closeJoinLinkDialog();
    openJoinLinkDialog(LINK);
    render(JoinSharedFolderDialog);

    expect(
      (screen.getByLabelText('Invite link') as HTMLInputElement).value
    ).toBe(LINK);
    expect(button('Continue').disabled).toBe(false);
  });

  it('names a folder that has no readable name', async () => {
    openShareLink.mockResolvedValue(preview({ name: null }));
    render(JoinSharedFolderDialog);
    await look();

    expect(
      (await screen.findByTestId('join-link-preview')).textContent
    ).toContain('ann invites you to a shared folder');
  });

  it('forgets what it showed when the link changes', async () => {
    render(JoinSharedFolderDialog);
    await look();
    await screen.findByTestId('join-link-preview');

    await paste(LINK.replace('link_1', 'link_2'));

    expect(screen.queryByTestId('join-link-preview')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
    expect(button('Continue').disabled).toBe(false);
  });

  it('says a removed link does not work', async () => {
    openShareLink.mockRejectedValue(refused('does_not_exist'));
    render(JoinSharedFolderDialog);
    await look();

    expect(await screen.findByText(/This link does not work/)).toBeTruthy();
    expect(screen.queryByTestId('join-link-preview')).toBeNull();
  });

  it('says a link that has run out has run out', async () => {
    openShareLink.mockRejectedValue(refused('link_expired'));
    render(JoinSharedFolderDialog);
    await look();

    expect(await screen.findByText('This link has expired.')).toBeTruthy();
  });
});

describe('joining', () => {
  it('joins, says so, syncs and closes', async () => {
    render(JoinSharedFolderDialog);
    await look();
    await fireEvent.click(await screen.findByRole('button', { name: 'Join' }));

    await waitFor(() => expect(claimShareLink).toHaveBeenCalledWith(LINK));
    await waitFor(() => expect(joinLinkDialog.open).toBe(false));
    expect(pushToast).toHaveBeenCalledWith('Joined “Trip plans”', {
      variant: 'success'
    });
    // The folder arrives with a sync, so one is started right away.
    expect(runSync).toHaveBeenCalledOnce();
  });

  it('stays open and says why when joining is refused', async () => {
    claimShareLink.mockRejectedValue(refused('link_used'));
    render(JoinSharedFolderDialog);
    await look();
    await fireEvent.click(await screen.findByRole('button', { name: 'Join' }));

    expect(await screen.findByText('This link has been used up.')).toBeTruthy();
    expect(joinLinkDialog.open).toBe(true);
    expect(runSync).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('offers nothing to join to someone who has the folder', async () => {
    openShareLink.mockResolvedValue(preview({ already_member: true }));
    render(JoinSharedFolderDialog);
    await look();

    expect(
      await screen.findByText('You already have this folder.')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
  });

  it('sends someone who is not signed in there to sign in', async () => {
    openShareLink.mockResolvedValue(preview({ signed_in: false }));
    render(JoinSharedFolderDialog);
    await look();

    expect(
      await screen.findByText(
        'This link is for notes.example.test. Sign in there to join.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
    expect(screen.queryByText(/No account there yet/)).toBeNull();
  });

  it('says where to sign up with a link that can create an account', async () => {
    openShareLink.mockResolvedValue(
      preview({ signed_in: false, can_signup: true })
    );
    render(JoinSharedFolderDialog);
    await look();

    expect(await screen.findByText(/No account there yet/)).toBeTruthy();
  });
});

describe('closing', () => {
  it('closes from the close button', async () => {
    render(JoinSharedFolderDialog);
    await fireEvent.click(screen.getByLabelText('Close'));

    expect(joinLinkDialog.open).toBe(false);
    expect(joinLinkDialog.link).toBe('');
  });
});
