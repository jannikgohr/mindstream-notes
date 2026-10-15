import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const flushPendingEditorSaves = vi.fn(async () => {});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

vi.mock('$lib/editor/suspend-flush', () => ({
  flushPendingEditorSaves: () => flushPendingEditorSaves()
}));

const {
  accountBeginAuthenticator,
  accountChangePassword,
  accountConfirmAuthenticator,
  accountEndOtherSessions,
  accountEndSession,
  accountNewBackupCodes,
  accountNewRecoveryKey,
  accountRecover,
  accountRemoveAuthenticator,
  accountSecurityStatus,
  accountServerInfo,
  accountSessions,
  accountSignup
} = await import('./account');

function setTauri(on: boolean): void {
  if (on) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

const SESSION = { username: 'ann', server_url: 'https://notes.example.test/' };
const SELF_HOSTED = {
  serverType: 'self-hosted' as const,
  serverUrl: 'https://notes.example.test'
};

beforeEach(() => {
  setTauri(true);
  invoke.mockReset();
  flushPendingEditorSaves.mockClear();
});

afterEach(() => {
  setTauri(false);
});

describe('signing up and recovering', () => {
  it('sends a signup with its code and returns the recovery key', async () => {
    invoke.mockResolvedValueOnce({
      session: SESSION,
      recovery_key: 'ABCD-EFGH'
    });

    const created = await accountSignup({
      ...SELF_HOSTED,
      username: 'ann',
      email: 'ann@example.test',
      password: 'correct horse',
      signupCode: ' ABCDE-FGHIJ '
    });

    expect(flushPendingEditorSaves).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('account_signup', {
      args: {
        server_type: 'self-hosted',
        server_url: 'https://notes.example.test',
        username: 'ann',
        email: 'ann@example.test',
        password: 'correct horse',
        signup_code: 'ABCDE-FGHIJ',
        invite_link: null
      }
    });
    expect(created).toEqual({ session: SESSION, recoveryKey: 'ABCD-EFGH' });
  });

  it('sends an invite link in place of a code', async () => {
    invoke.mockResolvedValueOnce({ session: SESSION, recovery_key: 'K' });
    const link = `https://notes.example.test/join/link_1#${'A'.repeat(43)}`;

    await accountSignup({
      ...SELF_HOSTED,
      username: 'ann',
      email: 'ann@example.test',
      password: 'correct horse',
      inviteLink: ` ${link} `
    });

    expect(invoke.mock.calls[0][1]).toMatchObject({
      args: { signup_code: null, invite_link: link }
    });
  });

  it('sends no signup code when the field was left empty', async () => {
    invoke.mockResolvedValueOnce({ session: SESSION, recovery_key: 'K' });

    await accountSignup({
      serverType: 'managed',
      username: 'ann',
      email: 'ann@example.test',
      password: 'correct horse',
      signupCode: '   '
    });

    expect(invoke.mock.calls[0][1]).toMatchObject({
      args: { server_type: 'managed', server_url: null, signup_code: null }
    });
  });

  it('refuses a self-hosted signup without an address before asking Rust', async () => {
    await expect(
      accountSignup({
        serverType: 'self-hosted',
        username: 'ann',
        email: 'ann@example.test',
        password: 'correct horse'
      })
    ).rejects.toThrow(/serverUrl/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends a recovery with the key as typed and the code only when given', async () => {
    invoke.mockResolvedValue({ session: SESSION, recovery_key: 'NEW' });

    const recovered = await accountRecover({
      ...SELF_HOSTED,
      username: 'ann',
      recoveryKey: 'abcd efgh',
      newPassword: 'a new password'
    });
    expect(invoke).toHaveBeenLastCalledWith('account_recover', {
      args: {
        server_type: 'self-hosted',
        server_url: 'https://notes.example.test',
        username: 'ann',
        recovery_key: 'abcd efgh',
        new_password: 'a new password',
        code: null
      }
    });
    expect(recovered.recoveryKey).toBe('NEW');

    await accountRecover({
      ...SELF_HOSTED,
      username: 'ann',
      recoveryKey: 'abcd efgh',
      newPassword: 'a new password',
      code: '123456'
    });
    expect(invoke.mock.calls[1][1]).toMatchObject({ args: { code: '123456' } });
  });

  it('rejects an answer without a recovery key', async () => {
    invoke.mockResolvedValueOnce({ session: SESSION });
    await expect(
      accountSignup({
        serverType: 'managed',
        username: 'ann',
        email: 'ann@example.test',
        password: 'correct horse'
      })
    ).rejects.toThrow(/recovery_key/);
  });
});

describe('server info', () => {
  it('reads what the server says about signup', async () => {
    invoke.mockResolvedValueOnce({
      signup: 'invite',
      protocol: 1,
      version: '0.1.0'
    });
    await expect(accountServerInfo(SELF_HOSTED)).resolves.toEqual({
      signup: 'invite',
      protocol: 1,
      version: '0.1.0'
    });
    expect(invoke).toHaveBeenCalledWith('account_server_info', {
      serverType: 'self-hosted',
      serverUrl: 'https://notes.example.test'
    });
  });

  it('treats a signup policy it does not know as closed', async () => {
    invoke.mockResolvedValueOnce({
      signup: 'by-carrier-pigeon',
      protocol: 2,
      version: '9.0.0'
    });
    await expect(
      accountServerInfo({ serverType: 'managed' })
    ).resolves.toMatchObject({ signup: 'closed' });
  });
});

describe('account security', () => {
  it('reads the overview', async () => {
    invoke.mockResolvedValueOnce({
      authenticator: true,
      backup_codes: 9,
      recovery_key: true,
      session_verified: false
    });
    await expect(accountSecurityStatus()).resolves.toEqual({
      authenticator: true,
      backupCodes: 9,
      recoveryKey: true,
      sessionVerified: false
    });
  });

  it('starts an authenticator setup with the password and an optional code', async () => {
    invoke.mockResolvedValue({
      secret: 'JBSWY3DP',
      url: 'otpauth://totp/x',
      qr_svg: '<svg/>'
    });

    await expect(accountBeginAuthenticator('pw')).resolves.toEqual({
      secret: 'JBSWY3DP',
      url: 'otpauth://totp/x',
      qrSvg: '<svg/>'
    });
    expect(invoke).toHaveBeenLastCalledWith('account_begin_authenticator', {
      password: 'pw',
      code: null
    });

    await accountBeginAuthenticator('pw', '654321');
    expect(invoke).toHaveBeenLastCalledWith('account_begin_authenticator', {
      password: 'pw',
      code: '654321'
    });
  });

  it('returns backup codes from confirming and from replacing them', async () => {
    invoke.mockResolvedValue(['AAAA-BBBB', 'CCCC-DDDD']);

    await expect(accountConfirmAuthenticator('123456')).resolves.toEqual([
      'AAAA-BBBB',
      'CCCC-DDDD'
    ]);
    expect(invoke).toHaveBeenLastCalledWith('account_confirm_authenticator', {
      code: '123456'
    });

    await accountNewBackupCodes('pw', '123456');
    expect(invoke).toHaveBeenLastCalledWith('account_new_backup_codes', {
      password: 'pw',
      code: '123456'
    });
  });

  it('removes the authenticator, replaces the recovery key and changes the password', async () => {
    invoke.mockResolvedValueOnce(null);
    await accountRemoveAuthenticator('pw', '123456');
    expect(invoke).toHaveBeenLastCalledWith('account_remove_authenticator', {
      password: 'pw',
      code: '123456'
    });

    invoke.mockResolvedValueOnce('WXYZ-2345');
    await expect(accountNewRecoveryKey('pw')).resolves.toBe('WXYZ-2345');
    expect(invoke).toHaveBeenLastCalledWith('account_new_recovery_key', {
      password: 'pw',
      code: null
    });

    invoke.mockResolvedValueOnce(null);
    await accountChangePassword('a new password', ' 123456 ');
    expect(invoke).toHaveBeenLastCalledWith('account_change_password', {
      newPassword: 'a new password',
      code: '123456'
    });
  });

  it('asks for nothing with an empty password or code', async () => {
    await expect(accountBeginAuthenticator('')).rejects.toThrow(/password/);
    await expect(accountRemoveAuthenticator('pw', ' ')).rejects.toThrow(/code/);
    await expect(accountConfirmAuthenticator('')).rejects.toThrow(/code/);
    await expect(accountChangePassword('')).rejects.toThrow(/newPassword/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('devices', () => {
  it('lists the devices signed in', async () => {
    invoke.mockResolvedValueOnce([
      {
        id: 7,
        device_name: 'Mindstream Notes (LAPTOP, Windows) etebase/0.6.1',
        created_at: 1_790_000_000,
        last_used_at: 1_790_000_600,
        second_factor: true,
        current: true
      }
    ]);
    await expect(accountSessions()).resolves.toEqual([
      {
        id: 7,
        deviceName: 'Mindstream Notes (LAPTOP, Windows) etebase/0.6.1',
        createdAt: 1_790_000_000,
        lastUsedAt: 1_790_000_600,
        secondFactor: true,
        current: true
      }
    ]);
  });

  it('rejects a list that is not one', async () => {
    invoke.mockResolvedValueOnce({ sessions: [] });
    await expect(accountSessions()).rejects.toThrow(/array/);
  });

  it('signs out one device, or every other one', async () => {
    invoke.mockResolvedValue(null);
    await accountEndSession(7);
    expect(invoke).toHaveBeenLastCalledWith('account_end_session', { id: 7 });
    await accountEndOtherSessions();
    expect(invoke).toHaveBeenLastCalledWith(
      'account_end_other_sessions',
      undefined
    );
  });
});

describe('outside the app', () => {
  it('fails without calling anything', async () => {
    setTauri(false);
    await expect(accountSecurityStatus()).rejects.toThrow(/only available/);
    await expect(accountSessions()).rejects.toThrow(/only available/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
