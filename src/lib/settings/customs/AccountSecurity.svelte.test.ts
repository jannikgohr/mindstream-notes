import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.fn();
const sessions = vi.fn();
const changePassword = vi.fn();
const auth = vi.hoisted(() => ({
  session: null as { username: string; server_url: string } | null
}));

vi.mock('$lib/api/auth.svelte', () => ({
  authSession: {
    get current() {
      return auth.session;
    }
  }
}));

vi.mock('$lib/api/account', () => ({
  accountSecurityStatus: () => status(),
  accountSessions: () => sessions(),
  accountChangePassword: (password: string, code?: string) =>
    changePassword(password, code),
  accountBeginAuthenticator: vi.fn(),
  accountConfirmAuthenticator: vi.fn(),
  accountEndOtherSessions: vi.fn(),
  accountEndSession: vi.fn(),
  accountNewBackupCodes: vi.fn(),
  accountNewRecoveryKey: vi.fn(),
  accountRemoveAuthenticator: vi.fn()
}));

vi.mock('../store.svelte', () => ({ settingsDialog: { open: true } }));

import AccountSecurity from './AccountSecurity.svelte';

const OVERVIEW = {
  authenticator: false,
  backupCodes: 0,
  recoveryKey: true,
  sessionVerified: false
};

beforeEach(() => {
  auth.session = { username: 'ann', server_url: 'https://notes.example.test/' };
  status.mockReset();
  sessions.mockReset();
  sessions.mockResolvedValue([]);
  changePassword.mockReset();
});

afterEach(cleanup);

describe('AccountSecurity', () => {
  it('asks nothing of the server while signed out', () => {
    auth.session = null;
    render(AccountSecurity);
    expect(screen.getByText(/Sign in to manage/)).toBeTruthy();
    expect(status).not.toHaveBeenCalled();
  });

  it('shows what the account has set up', async () => {
    status.mockResolvedValueOnce(OVERVIEW);
    render(AccountSecurity);

    expect(
      (await screen.findByTestId('two-factor-status')).textContent
    ).toMatch(/Off/);
    expect(screen.getByTestId('recovery-key-status').textContent).toMatch(
      /has a recovery key/
    );
    expect(screen.getByTestId('account-devices')).toBeTruthy();
  });

  it('warns when the account has no recovery key', async () => {
    status.mockResolvedValueOnce({ ...OVERVIEW, recoveryKey: false });
    render(AccountSecurity);
    expect(
      (await screen.findByTestId('recovery-key-status')).textContent
    ).toMatch(/no way back in/);
  });

  it('says why it could not load and tries again when asked', async () => {
    status
      .mockRejectedValueOnce({
        code: 'refused',
        message: 'no',
        reason: 'unreachable'
      })
      .mockResolvedValueOnce(OVERVIEW);
    render(AccountSecurity);

    expect(await screen.findByText(/reach the server/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('two-factor-status')).toBeTruthy();
  });

  it('reads everything again after the password changed', async () => {
    status.mockResolvedValue(OVERVIEW);
    changePassword.mockResolvedValueOnce(undefined);
    render(AccountSecurity);
    await screen.findByTestId('account-password');
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(1));

    await fireEvent.click(
      screen.getByRole('button', { name: 'Change password' })
    );
    await fireEvent.input(screen.getByLabelText('New password'), {
      target: { value: 'a new password' }
    });
    await fireEvent.input(screen.getByLabelText('Repeat password'), {
      target: { value: 'a new password' }
    });
    const submit = screen
      .getAllByRole('button', { name: 'Change password' })
      .find((el) => el.getAttribute('type') === 'submit');
    await fireEvent.click(submit as HTMLElement);

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith('a new password', '')
    );
    expect(
      await screen.findByText(/Every other device was signed out/)
    ).toBeTruthy();
    // The other devices are gone from the server, so the list is asked for
    // again, and so is the overview.
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(2));
    expect(status).toHaveBeenCalledTimes(2);
  });
});
