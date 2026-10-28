/**
 * The signed-out half of the account panel: signing in with a second
 * factor, creating an account, and getting back in with a recovery key.
 * The wire is covered by the server's own tests against the client
 * library. What is covered here is what the form does with the answers.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import { CommandErrorCode } from '$lib/api/core';
import type { ServerCheckResult } from '$lib/api/auth.svelte';

const etebaseLogin = vi.fn();
const adoptSession = vi.fn();
const accountSignup = vi.fn();
const accountRecover = vi.fn();
const accountServerInfo = vi.fn();
const checkEtebaseServerUrl = vi.fn();
const settings = new SvelteMap<string, unknown>();

vi.mock('$lib/api/auth.svelte', () => ({
  MANAGED_SERVER_URL: 'https://managed.example.test/',
  authSession: { initialised: true, current: null },
  adoptSession: (session: unknown) => adoptSession(session),
  checkEtebaseServerUrl: (url: string) => checkEtebaseServerUrl(url),
  etebaseLogin: (input: unknown) => etebaseLogin(input),
  etebaseLogout: vi.fn(),
  refreshAuthSession: vi.fn(async () => {})
}));

vi.mock('$lib/api/account', () => ({
  accountRecover: (input: unknown) => accountRecover(input),
  accountServerInfo: (target: unknown) => accountServerInfo(target),
  accountSignup: (input: unknown) => accountSignup(input)
}));

vi.mock('$lib/sync/runner', () => ({ runSync: vi.fn() }));

vi.mock('$lib/notifications/store.svelte', () => ({
  upsertNotification: vi.fn()
}));

vi.mock('../store.svelte', () => ({
  getSettingValue: (id: string) => settings.get(id),
  setSettingValue: vi.fn(async (id: string, value: unknown) => {
    settings.set(id, value);
  }),
  settingsDialog: { open: false }
}));

import { pendingReveal } from '$lib/account/pending-reveal.svelte';
import SignInForm from './SignInForm.svelte';

const SESSION = { username: 'ann', server_url: 'https://notes.example.test/' };

function refused(reason: string) {
  return { code: CommandErrorCode.Refused, message: 'server words', reason };
}

async function type(label: string, value: string) {
  await fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

const button = (name: string) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  settings.clear();
  settings.set('account.serverType', 'self-hosted');
  settings.set('account.serverUrl', 'https://notes.example.test');
  etebaseLogin.mockReset();
  adoptSession.mockReset();
  accountSignup.mockReset();
  accountRecover.mockReset();
  accountServerInfo.mockReset();
  checkEtebaseServerUrl.mockReset();
  checkEtebaseServerUrl.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    url
  }));
  accountServerInfo.mockResolvedValue({
    signup: 'open',
    protocol: 1,
    version: '0.1.0'
  });
  pendingReveal.current = null;
});

afterEach(cleanup);

describe('checking the server URL', () => {
  it.each<[string, RegExp]>([
    ['server_protocol_too_new', /Update the app to connect/],
    ['server_protocol_too_old', /Ask the server administrator to update/],
    ['not_a_mindstream_server', /does not answer like a Mindstream/]
  ])(
    'shows the refusal for %s without a success message',
    async (reason, message) => {
      checkEtebaseServerUrl.mockRejectedValueOnce(refused(reason));
      render(SignInForm);
      await fireEvent.click(button('Check URL'));

      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toMatch(message)
      );
      expect(screen.queryByText(/Server is healthy and compatible/)).toBeNull();
      expect(screen.queryByTestId('account-error')).toBeNull();
    }
  );

  it('checks the normalized URL on blur and shows the result by the field', async () => {
    render(SignInForm);
    await type('Server URL', 'notes.example.test/');
    expect(checkEtebaseServerUrl).not.toHaveBeenCalled();

    await fireEvent.blur(screen.getByLabelText('Server URL'));

    await waitFor(() => expect(checkEtebaseServerUrl).toHaveBeenCalledOnce());
    expect(checkEtebaseServerUrl).toHaveBeenCalledWith(
      'https://notes.example.test'
    );
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Server is healthy and compatible at https://notes.example.test'
      )
    );
  });

  it.each(['', 'not a url', 'ftp://notes.example.test'])(
    'skips automatic checks for an empty or invalid URL: %s',
    async (url) => {
      render(SignInForm);
      await type('Server URL', url);
      await fireEvent.blur(screen.getByLabelText('Server URL'));

      expect(checkEtebaseServerUrl).not.toHaveBeenCalled();
      expect(button('Check URL').disabled).toBe(true);
    }
  );

  it('lets the icon button retry a failed automatic check', async () => {
    checkEtebaseServerUrl.mockRejectedValueOnce(new Error('Connection failed'));
    render(SignInForm);
    await fireEvent.blur(screen.getByLabelText('Server URL'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Connection failed'
      )
    );
    expect(screen.queryByTestId('account-error')).toBeNull();

    await fireEvent.click(button('Check URL'));

    await waitFor(() => expect(checkEtebaseServerUrl).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Server is healthy and compatible'
      )
    );
    expect(screen.getByRole('status').textContent).not.toContain(
      'Connection failed'
    );
  });

  it('checks once when leaving the field to click the check button', async () => {
    render(SignInForm);
    const check = button('Check URL');
    await fireEvent.blur(screen.getByLabelText('Server URL'), {
      relatedTarget: check
    });
    expect(checkEtebaseServerUrl).not.toHaveBeenCalled();

    await fireEvent.click(check);

    await waitFor(() => expect(checkEtebaseServerUrl).toHaveBeenCalledOnce());
  });

  it('reports an unhealthy server below the URL', async () => {
    checkEtebaseServerUrl.mockResolvedValueOnce({
      ok: false,
      status: 503,
      url: 'https://notes.example.test'
    });
    render(SignInForm);
    await fireEvent.blur(screen.getByLabelText('Server URL'));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Health check returned HTTP 503 at https://notes.example.test'
      )
    );
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a stale check that finishes with %s after the URL changes',
    async (outcome) => {
      let resolveOld!: (result: ServerCheckResult) => void;
      let rejectOld!: (error: Error) => void;
      checkEtebaseServerUrl.mockImplementationOnce(
        () =>
          new Promise<ServerCheckResult>((resolve, reject) => {
            resolveOld = resolve;
            rejectOld = reject;
          })
      );
      render(SignInForm);
      await fireEvent.blur(screen.getByLabelText('Server URL'));
      expect(button('Checking…').disabled).toBe(true);
      await fireEvent.blur(screen.getByLabelText('Server URL'));
      expect(checkEtebaseServerUrl).toHaveBeenCalledOnce();

      await type('Server URL', 'https://new.example.test');
      await fireEvent.blur(screen.getByLabelText('Server URL'));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain(
          'Server is healthy and compatible at https://new.example.test'
        )
      );

      if (outcome === 'resolve') {
        resolveOld({
          ok: true,
          status: 200,
          url: 'https://notes.example.test'
        });
      } else {
        rejectOld(new Error('Old server failed'));
      }
      await waitFor(() => expect(button('Check URL').disabled).toBe(false));
      expect(screen.getByRole('status').textContent).toContain(
        'Server is healthy and compatible at https://new.example.test'
      );
      expect(screen.getByRole('status').textContent).not.toContain(
        'Old server failed'
      );
      expect(screen.queryByTestId('account-error')).toBeNull();
    }
  );

  it('keeps sign-in errors when an automatic URL check succeeds', async () => {
    etebaseLogin.mockRejectedValueOnce(refused('login_bad_signature'));
    render(SignInForm);
    await type('Username', 'ann');
    await type('Password', 'not it');
    await fireEvent.click(button('Sign in'));
    await screen.findByTestId('account-error');

    await fireEvent.blur(screen.getByLabelText('Server URL'));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Server is healthy and compatible'
      )
    );
    expect(screen.getByTestId('account-error').textContent).toMatch(
      /Wrong password/
    );
  });
});

describe('signing in', () => {
  it('signs in with a password alone and shows no code field', async () => {
    etebaseLogin.mockResolvedValueOnce(SESSION);
    render(SignInForm);
    await type('Username', ' ann ');
    await type('Password', 'hunter22');
    await fireEvent.click(button('Sign in'));

    await waitFor(() => expect(etebaseLogin).toHaveBeenCalledOnce());
    expect(etebaseLogin).toHaveBeenCalledWith({
      serverType: 'self-hosted',
      serverUrl: 'https://notes.example.test',
      username: 'ann',
      password: 'hunter22',
      code: undefined
    });
    expect(screen.queryByLabelText('Code')).toBeNull();
  });

  it('asks for a code when the server wants one, then sends it', async () => {
    etebaseLogin
      .mockRejectedValueOnce(refused('totp_required'))
      .mockResolvedValueOnce(SESSION);
    render(SignInForm);
    await type('Username', 'ann');
    await type('Password', 'hunter22');
    await fireEvent.click(button('Sign in'));

    // A prompt, not a failure.
    const code = await screen.findByLabelText('Code');
    expect(screen.queryByTestId('account-error')).toBeNull();

    await fireEvent.input(code, { target: { value: '123456' } });
    await fireEvent.click(button('Sign in'));
    await waitFor(() => expect(etebaseLogin).toHaveBeenCalledTimes(2));
    expect(etebaseLogin.mock.calls[1][0]).toMatchObject({
      password: 'hunter22',
      code: '123456'
    });
  });

  it('says so when the code is wrong', async () => {
    etebaseLogin
      .mockRejectedValueOnce(refused('totp_required'))
      .mockRejectedValueOnce(refused('totp_invalid'));
    render(SignInForm);
    await type('Username', 'ann');
    await type('Password', 'hunter22');
    await fireEvent.click(button('Sign in'));
    await fireEvent.input(await screen.findByLabelText('Code'), {
      target: { value: '000000' }
    });
    await fireEvent.click(button('Sign in'));

    expect((await screen.findByTestId('account-error')).textContent).toMatch(
      /code is not right/
    );
  });

  it('translates a wrong password and keeps the server words for the rest', async () => {
    etebaseLogin
      .mockRejectedValueOnce(refused('login_bad_signature'))
      .mockRejectedValueOnce(refused('something_new'));
    render(SignInForm);
    await type('Username', 'ann');
    await type('Password', 'not it');
    await fireEvent.click(button('Sign in'));
    expect((await screen.findByTestId('account-error')).textContent).toMatch(
      /Wrong password/
    );

    await fireEvent.click(button('Sign in'));
    await waitFor(() =>
      expect(screen.getByTestId('account-error').textContent).toMatch(
        /server words/
      )
    );
  });

  it('will not submit without a server address', async () => {
    settings.set('account.serverUrl', '');
    render(SignInForm);
    await type('Username', 'ann');
    await type('Password', 'hunter22');
    expect(button('Sign in').disabled).toBe(true);
  });
});

describe('creating an account', () => {
  async function openSignup() {
    render(SignInForm);
    await fireEvent.click(button('Create an account'));
    await waitFor(() => expect(accountServerInfo).toHaveBeenCalled());
  }

  it('shows the recovery key and signs in only once it is stored', async () => {
    accountSignup.mockResolvedValueOnce({
      session: SESSION,
      recoveryKey: 'ABCD-EFGH-IJKL'
    });
    await openSignup();
    // An open server asks for no code.
    await waitFor(() =>
      expect(screen.queryByLabelText('Signup code')).toBeNull()
    );
    await type('Username', 'ann');
    await type('Email', 'ann@example.test');
    await type('Password', 'correct horse');
    await type('Repeat password', 'correct horse');
    await fireEvent.click(button('Create account'));

    expect(await screen.findByText('ABCD-EFGH-IJKL')).toBeTruthy();
    expect(accountSignup).toHaveBeenCalledWith({
      serverType: 'self-hosted',
      serverUrl: 'https://notes.example.test',
      username: 'ann',
      email: 'ann@example.test',
      password: 'correct horse',
      signupCode: ''
    });
    // The session is not taken over, and the window not reloaded, yet.
    expect(adoptSession).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('secret-reveal-stored'));
    await fireEvent.click(screen.getByTestId('secret-reveal-done'));
    expect(adoptSession).toHaveBeenCalledWith(SESSION);
    expect(pendingReveal.current).toBeNull();
  });

  it('shows the key again if the panel was closed before it was stored', async () => {
    pendingReveal.current = { session: SESSION, recoveryKey: 'ABCD-EFGH-IJKL' };
    render(SignInForm);
    expect(screen.getByText('ABCD-EFGH-IJKL')).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
  });

  it('asks for a signup code where the server is not open', async () => {
    accountServerInfo.mockResolvedValue({
      signup: 'closed',
      protocol: 1,
      version: '0.1.0'
    });
    await openSignup();
    await type('Username', 'ann');
    await type('Email', 'ann@example.test');
    await type('Password', 'correct horse');
    await type('Repeat password', 'correct horse');
    await screen.findByLabelText('Signup code');
    await waitFor(() => expect(button('Create account').disabled).toBe(true));

    await type('Signup code', 'ABCDE-FGHIJ');
    expect(button('Create account').disabled).toBe(false);
  });

  describe('with an invite link', () => {
    const SECRET = 'A'.repeat(43);
    const HERE = `https://notes.example.test/join/link_1#${SECRET}`;
    const ELSEWHERE = `https://other.example.test/join/link_1#${SECRET}`;

    async function fillIn(link: string) {
      accountServerInfo.mockResolvedValue({
        signup: 'invite',
        protocol: 1,
        version: '0.1.0'
      });
      await openSignup();
      await type('Username', 'ann');
      await type('Email', 'ann@example.test');
      await type('Password', 'correct horse');
      await type('Repeat password', 'correct horse');
      await screen.findByLabelText('Signup code');
      await type('Signup code', link);
    }

    it('signs up with the link and sends no code', async () => {
      accountSignup.mockResolvedValueOnce({
        session: SESSION,
        recoveryKey: 'ABCD-EFGH-IJKL'
      });
      await fillIn(` ${HERE} `);
      expect(
        screen.getByText(/Your account will join the folder/)
      ).toBeTruthy();
      await fireEvent.click(button('Create account'));

      await waitFor(() => expect(accountSignup).toHaveBeenCalledOnce());
      const sent = accountSignup.mock.calls[0][0];
      expect(sent.inviteLink).toBe(HERE);
      expect(sent.signupCode).toBeUndefined();
    });

    it('holds back a link that is for another server', async () => {
      await fillIn(ELSEWHERE);

      expect(
        screen.getByText(
          'This link is for other.example.test, not for the server set above.'
        )
      ).toBeTruthy();
      expect(button('Create account').disabled).toBe(true);
      expect(accountSignup).not.toHaveBeenCalled();
    });

    it("can switch to the link's server", async () => {
      await fillIn(ELSEWHERE);
      await fireEvent.click(button('Use other.example.test'));

      await waitFor(() =>
        expect(settings.get('account.serverUrl')).toBe(
          'https://other.example.test/'
        )
      );
      expect(settings.get('account.serverType')).toBe('self-hosted');
    });

    it('takes anything else in the field for a code', async () => {
      accountSignup.mockResolvedValueOnce({
        session: SESSION,
        recoveryKey: 'ABCD-EFGH-IJKL'
      });
      await fillIn('ABCDE-FGHIJ');
      await fireEvent.click(button('Create account'));

      await waitFor(() => expect(accountSignup).toHaveBeenCalledOnce());
      const sent = accountSignup.mock.calls[0][0];
      expect(sent.signupCode).toBe('ABCDE-FGHIJ');
      expect(sent.inviteLink).toBeUndefined();
    });
  });

  it('holds back a short or mismatched password', async () => {
    await openSignup();
    await type('Username', 'ann');
    await type('Email', 'ann@example.test');
    await type('Password', 'short');
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();

    await type('Password', 'correct horse');
    await type('Repeat password', 'correct house');
    expect(
      screen.getByText('The two passwords are not the same.')
    ).toBeTruthy();
    expect(button('Create account').disabled).toBe(true);
    expect(accountSignup).not.toHaveBeenCalled();
  });

  it('says so when the address is not a sync server', async () => {
    accountServerInfo.mockRejectedValue(refused('not_a_mindstream_server'));
    await openSignup();
    expect((await screen.findByTestId('account-error')).textContent).toMatch(
      /does not answer like a Mindstream sync server/
    );
  });
});

describe('recovering', () => {
  it('sets a new password with the recovery key and shows the new key', async () => {
    accountRecover.mockResolvedValueOnce({
      session: SESSION,
      recoveryKey: 'NEWK-EYNE-WKEY'
    });
    render(SignInForm);
    await fireEvent.click(button('Forgot your password?'));
    await type('Username', 'ann');
    await type('Recovery key', 'abcd efgh');
    await type('New password', 'a new password');
    await type('Repeat password', 'a new password');
    await fireEvent.click(button('Set new password'));

    expect(await screen.findByText('NEWK-EYNE-WKEY')).toBeTruthy();
    expect(accountRecover).toHaveBeenCalledWith({
      serverType: 'self-hosted',
      serverUrl: 'https://notes.example.test',
      username: 'ann',
      recoveryKey: 'abcd efgh',
      newPassword: 'a new password',
      code: undefined
    });
  });

  it('asks for a code where the account has a second factor', async () => {
    accountRecover
      .mockRejectedValueOnce(refused('totp_required'))
      .mockResolvedValueOnce({ session: SESSION, recoveryKey: 'NEWK' });
    render(SignInForm);
    await fireEvent.click(button('Forgot your password?'));
    await type('Username', 'ann');
    await type('Recovery key', 'abcd efgh');
    await type('New password', 'a new password');
    await type('Repeat password', 'a new password');
    await fireEvent.click(button('Set new password'));

    await fireEvent.input(await screen.findByLabelText('Code'), {
      target: { value: '123456' }
    });
    await fireEvent.click(button('Set new password'));
    await waitFor(() => expect(accountRecover).toHaveBeenCalledTimes(2));
    expect(accountRecover.mock.calls[1][0]).toMatchObject({ code: '123456' });
  });

  it('goes back to signing in with the passwords cleared', async () => {
    render(SignInForm);
    await fireEvent.click(button('Forgot your password?'));
    await type('New password', 'a new password');
    await fireEvent.click(button('Back to sign in'));

    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(
      ''
    );
    expect(screen.queryByLabelText('Recovery key')).toBeNull();
  });
});
