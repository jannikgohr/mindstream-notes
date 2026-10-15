import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandErrorCode } from '$lib/api/core';
import type { ShareLink } from '$lib/api/sharing';

const createShareLink = vi.fn();
const listShareLinks = vi.fn();
const revokeShareLink = vi.fn();
const loadTree = vi.fn();
const pushToast = vi.fn();

vi.mock('$lib/api/sharing', () => ({
  createShareLink: (input: unknown) => createShareLink(input),
  listShareLinks: (id: string) => listShareLinks(id),
  revokeShareLink: (uid: string) => revokeShareLink(uid)
}));
vi.mock('$lib/stores/tree.svelte', () => ({ loadTree: () => loadTree() }));
vi.mock('./toast.svelte', () => ({
  pushToast: (message: string, options: unknown) => pushToast(message, options)
}));

import ShareLinksSection from './ShareLinksSection.svelte';

const LINK = `https://notes.example.test/join/link_1#${'A'.repeat(43)}`;

function link(over: Partial<ShareLink> = {}): ShareLink {
  return {
    uid: 'link_1',
    access_level: 'read_only',
    max_uses: 5,
    uses: 2,
    allows_signup: false,
    // 2030-01-15, far from any day boundary in any time zone.
    expires_at: Date.UTC(2030, 0, 15, 12) / 1000,
    created_at: Date.UTC(2030, 0, 8, 12) / 1000,
    sender_username: 'ann',
    ...over
  };
}

const button = (name: string) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

async function choose(label: string, value: string) {
  await fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  createShareLink.mockReset();
  listShareLinks.mockReset().mockResolvedValue([]);
  revokeShareLink.mockReset().mockResolvedValue(undefined);
  loadTree.mockReset().mockResolvedValue(undefined);
  pushToast.mockReset();
});

afterEach(cleanup);

describe('the links of a folder', () => {
  it('lists each link with its rights, its uses and its last day', async () => {
    listShareLinks.mockResolvedValue([
      link(),
      link({ uid: 'link_2', access_level: 'read_write', uses: 0, max_uses: 1 })
    ]);
    render(ShareLinksSection, { collectionId: 'folder_1' });

    const rows = await screen.findAllByTestId('share-link');
    expect(listShareLinks).toHaveBeenCalledWith('folder_1');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Can view');
    expect(rows[0].textContent).toContain('2 of 5 used');
    expect(rows[0].textContent).toContain('2030');
    expect(rows[1].textContent).toContain('Can edit');
    expect(rows[1].textContent).toContain('0 of 1 used');
    // A link that exists cannot be shown again, so there is no text to copy.
    expect(screen.queryByTestId('share-link-text')).toBeNull();
  });

  it('says so when the links cannot be loaded', async () => {
    listShareLinks.mockRejectedValue(new Error('offline'));
    render(ShareLinksSection, { collectionId: 'folder_1' });

    expect(await screen.findByText("Couldn't load the links.")).toBeTruthy();
  });

  it('removes a link and lists what is left', async () => {
    listShareLinks.mockResolvedValueOnce([link()]).mockResolvedValueOnce([]);
    render(ShareLinksSection, { collectionId: 'folder_1' });

    await fireEvent.click(await screen.findByLabelText('Remove link'));

    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('link_1'));
    await waitFor(() => expect(screen.queryByTestId('share-link')).toBeNull());
  });

  it('keeps a link it could not remove and says so', async () => {
    listShareLinks.mockResolvedValue([link()]);
    revokeShareLink.mockRejectedValue(new Error('offline'));
    render(ShareLinksSection, { collectionId: 'folder_1' });

    await fireEvent.click(await screen.findByLabelText('Remove link'));

    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith("Couldn't remove the link.", {
        variant: 'error'
      })
    );
    expect(screen.getAllByTestId('share-link')).toHaveLength(1);
  });
});

describe('making a link', () => {
  it('asks for a view-only link for one person for a week by default', async () => {
    createShareLink.mockResolvedValue({ link: LINK, uid: 'link_1' });
    render(ShareLinksSection, { collectionId: 'folder_1' });

    await fireEvent.click(button('Create link'));

    await waitFor(() => expect(createShareLink).toHaveBeenCalledOnce());
    expect(createShareLink).toHaveBeenCalledWith({
      collection_id: 'folder_1',
      access_level: 'read_only',
      max_uses: 1,
      expires_in_days: 7,
      allow_signup: false
    });
  });

  it('shows the new link once, refreshes the tree and the list', async () => {
    createShareLink.mockResolvedValue({ link: LINK, uid: 'link_1' });
    listShareLinks.mockResolvedValueOnce([]).mockResolvedValueOnce([link()]);
    render(ShareLinksSection, { collectionId: 'folder_1' });

    await fireEvent.click(button('Create link'));

    expect((await screen.findByTestId('share-link-text')).textContent).toBe(
      LINK
    );
    // Making a link shares a folder that was not shared yet.
    expect(loadTree).toHaveBeenCalled();
    expect(await screen.findAllByTestId('share-link')).toHaveLength(1);
  });

  it('sends what was chosen', async () => {
    createShareLink.mockResolvedValue({ link: LINK, uid: 'link_1' });
    render(ShareLinksSection, { collectionId: 'folder_1' });

    await choose('Permission', 'read_write');
    await choose('How many people', '25');
    await choose('How long it lasts', '30');
    await fireEvent.click(button('Create link'));

    await waitFor(() => expect(createShareLink).toHaveBeenCalledOnce());
    expect(createShareLink.mock.calls[0][0]).toMatchObject({
      access_level: 'read_write',
      max_uses: 25,
      expires_in_days: 30
    });
  });

  it('offers no admin link', () => {
    render(ShareLinksSection, { collectionId: 'folder_1' });

    const options = Array.from(
      (screen.getByLabelText('Permission') as HTMLSelectElement).options
    ).map((option) => option.value);
    expect(options).toEqual(['read_only', 'read_write']);
  });

  it('offers account creation only where the server allows it', async () => {
    createShareLink.mockResolvedValue({ link: LINK, uid: 'link_1' });
    const first = render(ShareLinksSection, { collectionId: 'folder_1' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    first.unmount();

    render(ShareLinksSection, { collectionId: 'folder_1', signupByLink: true });
    await fireEvent.click(screen.getByRole('checkbox'));
    await fireEvent.click(button('Create link'));

    await waitFor(() => expect(createShareLink).toHaveBeenCalledOnce());
    expect(createShareLink.mock.calls[0][0]).toMatchObject({
      allow_signup: true
    });
  });

  it('says why the server refused', async () => {
    createShareLink.mockRejectedValue({
      code: CommandErrorCode.Refused,
      message: 'server words',
      reason: 'too_many_links'
    });
    render(ShareLinksSection, { collectionId: 'folder_1' });

    await fireEvent.click(button('Create link'));

    expect(await screen.findByText(/too many links already/)).toBeTruthy();
    expect(screen.queryByTestId('share-link-text')).toBeNull();
    expect(button('Create link').disabled).toBe(false);
  });

  it('copies the new link', async () => {
    createShareLink.mockResolvedValue({ link: LINK, uid: 'link_1' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    });
    render(ShareLinksSection, { collectionId: 'folder_1' });

    await fireEvent.click(button('Create link'));
    await screen.findByTestId('share-link-text');
    await fireEvent.click(button('Copy link'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK));
    expect(pushToast).toHaveBeenCalledWith('Link copied', {
      variant: 'success'
    });
  });
});
