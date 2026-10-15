import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ownKeyFingerprint = vi.fn();

vi.mock('$lib/api/sharing', () => ({
  ownKeyFingerprint: () => ownKeyFingerprint()
}));

import KeySection from './KeySection.svelte';

const DIGITS = '45680   71497   88570   93128\n19189   84243   25687   20837';

beforeEach(() => {
  ownKeyFingerprint.mockReset().mockResolvedValue(DIGITS);
});

afterEach(cleanup);

describe('KeySection', () => {
  it('shows the account key as digits, rows kept', async () => {
    render(KeySection);

    const shown = await screen.findByTestId('key-fingerprint');
    expect(shown.textContent).toBe(DIGITS);
    expect(screen.getByText('Your key')).toBeTruthy();
    expect(
      screen.getByText(/People you share with can compare these digits/)
    ).toBeTruthy();
  });

  it('says so when the key cannot be read', async () => {
    ownKeyFingerprint.mockRejectedValue(new Error('offline'));
    render(KeySection);

    expect(await screen.findByText("Couldn't read your key.")).toBeTruthy();
    expect(screen.queryByTestId('key-fingerprint')).toBeNull();
  });
});
