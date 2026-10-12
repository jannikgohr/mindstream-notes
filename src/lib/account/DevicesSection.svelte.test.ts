import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSession } from '$lib/api/account';

const sessions = vi.fn();
const endSession = vi.fn();
const endOthers = vi.fn();

vi.mock('$lib/api/account', () => ({
  accountSessions: () => sessions(),
  accountEndSession: (id: number) => endSession(id),
  accountEndOtherSessions: () => endOthers()
}));

import DevicesSection from './DevicesSection.svelte';

function device(over: Partial<DeviceSession>): DeviceSession {
  return {
    id: 1,
    deviceName: 'Mindstream Notes (LAPTOP, Windows) etebase/0.6.1',
    createdAt: 1_790_000_000,
    lastUsedAt: 1_790_000_000,
    secondFactor: false,
    current: false,
    ...over
  };
}

const LAPTOP = device({ id: 1, current: true });
const PHONE = device({
  id: 2,
  deviceName: 'Mindstream Notes (Android) etebase/0.6.1',
  lastUsedAt: 1_790_000_500,
  secondFactor: true
});
const TABLET = device({ id: 3, deviceName: '', lastUsedAt: 1_790_000_100 });

const rows = () => screen.getAllByTestId('account-device');

beforeEach(() => {
  sessions.mockReset();
  endSession.mockReset();
  endOthers.mockReset();
});

afterEach(cleanup);

describe('DevicesSection', () => {
  it('lists this device first and names each one readably', async () => {
    sessions.mockResolvedValueOnce([TABLET, PHONE, LAPTOP]);
    render(DevicesSection, { revision: 0 });

    await waitFor(() => expect(rows()).toHaveLength(3));
    const [first, second, third] = rows();
    expect(first.textContent).toMatch(/Mindstream Notes \(LAPTOP, Windows\)/);
    expect(first.textContent).toMatch(/This device/);
    expect(first.textContent).not.toMatch(/etebase/);
    expect(second.textContent).toMatch(/Android/);
    expect(second.textContent).toMatch(/Signed in with a code/);
    expect(third.textContent).toMatch(/Unknown device/);
  });

  it('has no way to sign this device out from the list', async () => {
    sessions.mockResolvedValueOnce([LAPTOP, PHONE]);
    render(DevicesSection, { revision: 0 });
    await waitFor(() => expect(rows()).toHaveLength(2));

    expect(rows()[0].querySelector('button')).toBeNull();
    expect(rows()[1].querySelector('button')).not.toBeNull();
    // One other device: "all others" would say the same as its own button.
    expect(
      screen.queryByRole('button', { name: 'Sign out all other devices' })
    ).toBeNull();
  });

  it('signs one device out and reads the list again', async () => {
    sessions
      .mockResolvedValueOnce([LAPTOP, PHONE])
      .mockResolvedValueOnce([LAPTOP]);
    endSession.mockResolvedValueOnce(undefined);
    render(DevicesSection, { revision: 0 });
    await waitFor(() => expect(rows()).toHaveLength(2));

    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Sign out Mindstream Notes (Android)'
      })
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(endSession).toHaveBeenCalledWith(2);
  });

  it('signs every other device out at once', async () => {
    sessions
      .mockResolvedValueOnce([LAPTOP, PHONE, TABLET])
      .mockResolvedValueOnce([LAPTOP]);
    endOthers.mockResolvedValueOnce(undefined);
    render(DevicesSection, { revision: 0 });
    await waitFor(() => expect(rows()).toHaveLength(3));

    await fireEvent.click(
      screen.getByRole('button', { name: 'Sign out all other devices' })
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(endOthers).toHaveBeenCalledOnce();
    expect(endSession).not.toHaveBeenCalled();
  });

  it('says why when signing a device out fails, and keeps the list', async () => {
    sessions.mockResolvedValueOnce([LAPTOP, PHONE]);
    endSession.mockRejectedValueOnce({
      code: 'refused',
      message: 'no',
      reason: 'unreachable'
    });
    render(DevicesSection, { revision: 0 });
    await waitFor(() => expect(rows()).toHaveLength(2));

    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Sign out Mindstream Notes (Android)'
      })
    );
    expect(await screen.findByText(/reach the server/)).toBeTruthy();
    expect(rows()).toHaveLength(2);
  });

  it('reads the list again when the parent says something changed', async () => {
    sessions
      .mockResolvedValueOnce([LAPTOP, PHONE])
      .mockResolvedValueOnce([LAPTOP]);
    const { rerender } = render(DevicesSection, { revision: 0 });
    await waitFor(() => expect(rows()).toHaveLength(2));

    await rerender({ revision: 1 });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(sessions).toHaveBeenCalledTimes(2);
  });
});
