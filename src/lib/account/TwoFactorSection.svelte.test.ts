/**
 * Setting up an authenticator is three steps with a secret in the middle
 * and codes at the end that are shown once. This walks them, and the two
 * shorter flows next to it.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecurityOverview } from '$lib/api/account';

const begin = vi.fn();
const confirm = vi.fn();
const newBackupCodes = vi.fn();
const remove = vi.fn();

vi.mock('$lib/api/account', () => ({
  accountBeginAuthenticator: (password: string, code?: string) =>
    begin(password, code),
  accountConfirmAuthenticator: (code: string) => confirm(code),
  accountNewBackupCodes: (password: string, code: string) =>
    newBackupCodes(password, code),
  accountRemoveAuthenticator: (password: string, code: string) =>
    remove(password, code)
}));

import TwoFactorSection from './TwoFactorSection.svelte';

const OFF: SecurityOverview = {
  authenticator: false,
  backupCodes: 0,
  recoveryKey: true,
  sessionVerified: false
};
const ON: SecurityOverview = { ...OFF, authenticator: true, backupCodes: 10 };

function show(overview: SecurityOverview) {
  const onChanged = vi.fn();
  render(TwoFactorSection, { overview, onChanged });
  return onChanged;
}

async function type(label: string, value: string) {
  await fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

const button = (name: string) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  begin.mockReset();
  confirm.mockReset();
  newBackupCodes.mockReset();
  remove.mockReset();
});

afterEach(cleanup);

describe('TwoFactorSection', () => {
  it('sets up an authenticator and shows the backup codes before going on', async () => {
    begin.mockResolvedValueOnce({
      secret: 'JBSWY3DPEHPK3PXP',
      url: 'otpauth://totp/x',
      qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>'
    });
    confirm.mockResolvedValueOnce(['AAAA-BBBB', 'CCCC-DDDD']);
    const onChanged = show(OFF);
    expect(screen.getByTestId('two-factor-status').textContent).toMatch(/Off/);

    await fireEvent.click(button('Set up an authenticator'));
    // Nothing enrolled yet, so there is no code to ask for.
    expect(screen.queryByLabelText('Code')).toBeNull();
    await type('Password', 'hunter22');
    await fireEvent.click(button('Continue'));

    expect(
      (await screen.findByTestId('two-factor-secret')).textContent
    ).toMatch(/JBSWY3DPEHPK3PXP/);
    expect(begin).toHaveBeenCalledWith('hunter22', '');
    const qr = screen.getByRole('img') as HTMLImageElement;
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);

    await type('Code', ' 123456 ');
    await fireEvent.click(button('Turn on'));
    expect(await screen.findByText('AAAA-BBBB')).toBeTruthy();
    expect(confirm).toHaveBeenCalledWith('123456');
    // The account changed, but the parent hears of it only once the codes
    // are stored: a refresh would take them off the screen.
    expect(onChanged).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('secret-reveal-stored'));
    await fireEvent.click(screen.getByTestId('secret-reveal-done'));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByText('AAAA-BBBB')).toBeNull();
  });

  it('keeps the setup open when the code is wrong', async () => {
    begin.mockResolvedValueOnce({ secret: 'S', url: 'u', qrSvg: '<svg/>' });
    confirm.mockRejectedValueOnce({
      code: 'refused',
      message: 'no',
      reason: 'totp_invalid'
    });
    show(OFF);
    await fireEvent.click(button('Set up an authenticator'));
    await type('Password', 'hunter22');
    await fireEvent.click(button('Continue'));
    await screen.findByTestId('two-factor-secret');
    await type('Code', '000000');
    await fireEvent.click(button('Turn on'));

    expect(await screen.findByText(/code is not right/)).toBeTruthy();
    expect(screen.getByTestId('two-factor-secret')).toBeTruthy();
  });

  it('asks for a code to replace an authenticator this device did not sign in with', async () => {
    show(ON);
    expect(screen.getByTestId('two-factor-status').textContent).toMatch(
      /Backup codes left: 10/
    );
    await fireEvent.click(button('Replace the authenticator'));
    expect(screen.getByLabelText('Code')).toBeTruthy();
  });

  it('replaces it on the password alone from a device that signed in with it', async () => {
    show({ ...ON, sessionVerified: true });
    await fireEvent.click(button('Replace the authenticator'));
    expect(screen.queryByLabelText('Code')).toBeNull();
  });

  it('makes new backup codes with the password and a code', async () => {
    newBackupCodes.mockResolvedValueOnce(['EEEE-FFFF']);
    show(ON);
    await fireEvent.click(button('New backup codes'));
    await type('Password', 'hunter22');
    await type('Code', '123456');
    // The form's own button, not the one that opened it.
    const submit = screen
      .getAllByRole('button', { name: 'New backup codes' })
      .find((el) => el.getAttribute('type') === 'submit');
    await fireEvent.click(submit as HTMLElement);

    expect(await screen.findByText('EEEE-FFFF')).toBeTruthy();
    expect(newBackupCodes).toHaveBeenCalledWith('hunter22', '123456');
  });

  it('turns it off and tells the parent', async () => {
    remove.mockResolvedValueOnce(undefined);
    const onChanged = show(ON);
    await fireEvent.click(button('Turn off'));
    await type('Password', 'hunter22');
    await type('Code', '123456');
    const submit = screen
      .getAllByRole('button', { name: 'Turn off' })
      .find((el) => el.getAttribute('type') === 'submit');
    await fireEvent.click(submit as HTMLElement);

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith('hunter22', '123456');
  });

  it('offers nothing to turn off when it is off', () => {
    show(OFF);
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'New backup codes' })
    ).toBeNull();
  });
});
