import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import ShareCollectionDialog from './ShareCollectionDialog.svelte';
import {
  closeCollectionShareDialog,
  openCollectionShareDialog
} from './share-dialog.svelte';

/**
 * The invite dialog's best-effort batch path. Outside Tauri `inviteCollection`
 * throws ("only available in the Tauri desktop app"), so every recipient fails
 * identically — which is exactly what we need to assert the per-recipient
 * failure reporting, the comma-splitting + de-duplication, and the "keep the
 * failed names for a retry" behaviour without a backend.
 *
 * This used to live in the browser Playwright suite, but sharing is now behind
 * a signed-in-only menu group and the browser fallback can never sign in, so
 * the dialog is unreachable there. The success path (a toast naming the invited
 * users) needs a real server and is covered by the T4 sharing e2e specs.
 */

function dialogInput(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement;
}

function inviteButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Invite' }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  closeCollectionShareDialog();
});

describe('ShareCollectionDialog', () => {
  it('shows the multi-user hint and placeholder', () => {
    openCollectionShareDialog('folder_work');
    render(ShareCollectionDialog);

    expect(dialogInput().placeholder).toBe('username, username');
    expect(
      screen.getByText('Separate multiple users with commas.')
    ).toBeTruthy();
  });

  it('reports each recipient and keeps the failed names', async () => {
    openCollectionShareDialog('folder_work');
    render(ShareCollectionDialog);

    const input = dialogInput();
    // Duplicate "alice" must collapse to one entry (case-insensitive dedup).
    await fireEvent.input(input, { target: { value: 'alice, bob, Alice' } });
    await fireEvent.click(inviteButton());

    // Best-effort: a failure heading plus exactly one line per unique recipient.
    expect(await screen.findByText("Couldn't invite:")).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('alice');
    expect(items[1].textContent).toContain('bob');

    // The field is rewritten to the failed names so the user can fix + resend
    // without retyping the whole list.
    expect(input.value).toBe('alice, bob');
  });

  it('disables Invite until a name is entered', async () => {
    openCollectionShareDialog('folder_work');
    render(ShareCollectionDialog);

    expect(inviteButton().disabled).toBe(true);

    // Whitespace / lone commas parse to zero recipients — still disabled.
    await fireEvent.input(dialogInput(), { target: { value: '  ,  ' } });
    expect(inviteButton().disabled).toBe(true);

    await fireEvent.input(dialogInput(), { target: { value: 'carol' } });
    expect(inviteButton().disabled).toBe(false);
  });
});
