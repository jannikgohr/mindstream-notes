import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userKeyInfo = vi.fn();

vi.mock('$lib/api/sharing', () => ({
  userKeyInfo: (username: string) => userKeyInfo(username)
}));

import KeyChangedNotice from './KeyChangedNotice.svelte';

const NOW = '11111   22222   33333   44444';
const BEFORE = '55555   66666   77777   88888';

const trustButton = () =>
  screen.getByRole('button', {
    name: 'Share with the new key'
  }) as HTMLButtonElement;

beforeEach(() => {
  userKeyInfo.mockReset().mockResolvedValue({
    username: 'ann',
    standing: 'changed',
    fingerprint: NOW,
    known_fingerprint: BEFORE
  });
});

afterEach(cleanup);

describe('KeyChangedNotice', () => {
  it('says whose key changed and shows both keys', async () => {
    render(KeyChangedNotice, { username: 'ann', onTrust: vi.fn() });

    expect(
      screen.getByText(/The key of ann is not the one you shared with before/)
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByTestId('key-fingerprint')).toHaveLength(2)
    );
    expect(userKeyInfo).toHaveBeenCalledWith('ann');
    const [now, before] = screen.getAllByTestId('key-fingerprint');
    expect(now.textContent).toBe(NOW);
    expect(before.textContent).toBe(BEFORE);
    expect(screen.getByText('Key now')).toBeTruthy();
    expect(screen.getByText('Key before')).toBeTruthy();
  });

  it('offers to go on only once the new key is on screen', async () => {
    let shown: (value: unknown) => void = () => {};
    userKeyInfo.mockReturnValue(
      new Promise((resolve) => {
        shown = resolve;
      })
    );
    const onTrust = vi.fn();
    render(KeyChangedNotice, { username: 'ann', onTrust });

    expect(trustButton().disabled).toBe(true);
    await fireEvent.click(trustButton());
    expect(onTrust).not.toHaveBeenCalled();

    shown({
      username: 'ann',
      standing: 'changed',
      fingerprint: NOW,
      known_fingerprint: BEFORE
    });
    await waitFor(() => expect(trustButton().disabled).toBe(false));
    await fireEvent.click(trustButton());
    expect(onTrust).toHaveBeenCalledOnce();
  });

  it('does not offer to trust a key it could not show', async () => {
    userKeyInfo.mockRejectedValue(new Error('offline'));
    render(KeyChangedNotice, { username: 'ann', onTrust: vi.fn() });

    expect(await screen.findByText("Couldn't read the key.")).toBeTruthy();
    expect(screen.queryByTestId('key-fingerprint')).toBeNull();
    expect(trustButton().disabled).toBe(true);
  });

  it('holds the button while something else is under way', async () => {
    render(KeyChangedNotice, {
      username: 'ann',
      disabled: true,
      onTrust: vi.fn()
    });

    await screen.findAllByTestId('key-fingerprint');
    expect(trustButton().disabled).toBe(true);
  });
});
