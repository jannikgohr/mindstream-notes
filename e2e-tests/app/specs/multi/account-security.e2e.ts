/**
 * T4 — account security across two devices (docs/server-design.md, Accounts).
 *
 * Two things here cannot be shown with one device or without a server:
 *
 *   - a second factor is asked for when a NEW device signs in, and the form
 *     only shows the field once the server has asked;
 *   - ending a session on the server signs that device out, at once, without
 *     the app quietly signing itself back in with the key it keeps.
 *
 * Device A is driven through the account commands, which is what the security
 * panel calls. Device B signs in through the real form, because the prompt for
 * a code is the form's own behaviour.
 */

import { expect } from '@wdio/globals';

import { backendUrl } from '../../helpers/backend.js';
import {
  clientHelpers,
  loginClient,
  waitForClientsReady,
  waitForTextInPage
} from '../../helpers/harness.js';
import { totpCode } from '../../helpers/totp.js';

declare const browserA: WebdriverIO.Browser;
declare const browserB: WebdriverIO.Browser;

interface SessionInfo {
  username: string;
  server_url: string;
}

interface NewAccount {
  session: SessionInfo;
  recovery_key: string;
}

interface SecurityOverview {
  authenticator: boolean;
  backup_codes: number;
  recovery_key: boolean;
  session_verified: boolean;
}

interface AuthenticatorSetup {
  secret: string;
  url: string;
  qr_svg: string;
}

interface DeviceSession {
  id: number;
  device_name: string;
  second_factor: boolean;
  current: boolean;
}

async function invokeTauri<T>(
  client: WebdriverIO.Browser,
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return client.execute(
    async (cmd: string, invokeArgs: Record<string, unknown> | undefined) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: <R>(
            command: string,
            args?: Record<string, unknown>
          ) => Promise<R>;
        };
      };
      const invoke = tauri.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error('Tauri invoke is not exposed in WebView');
      return invoke(cmd, invokeArgs);
    },
    command,
    args
  ) as Promise<T>;
}

/** Wait until the device no longer holds a session. */
async function waitForSignedOut(
  client: WebdriverIO.Browser,
  why: string
): Promise<void> {
  await client.waitUntil(
    async () =>
      (await invokeTauri<SessionInfo | null>(client, 'etebase_session')) ===
      null,
    {
      // The change feed says so within a second. The scheduled sync is the
      // fallback when the feed had not connected yet, and it runs every 30s.
      timeout: 90_000,
      interval: 500,
      timeoutMsg: `the device was not signed out: ${why}`
    }
  );
}

describe('T4 account security', function () {
  const server = backendUrl();
  const token = Date.now().toString(36);
  const username = `e2e-secure-${token}`;
  // Not secrets: a throwaway account on a disposable local stack.
  const password = `e2e-${token}-passphrase`;
  const newPassword = `e2e-${token}-second-passphrase`;
  let backupCodes: string[] = [];

  /** A backup code nothing has used yet. Each works once. */
  const nextBackupCode = (): string => {
    const code = backupCodes.shift();
    if (!code) throw new Error('out of backup codes');
    return code;
  };

  before(async function () {
    await waitForClientsReady({ browserA, browserB });
    // Whatever an earlier spec left signed in on A.
    await invokeTauri(browserA, 'etebase_logout');
  });

  it('creates an account with a recovery key', async function () {
    const created = await invokeTauri<NewAccount>(browserA, 'account_signup', {
      args: {
        server_type: 'self-hosted',
        server_url: server,
        username,
        email: `${username}@e2e.local`,
        password,
        signup_code: null
      }
    });
    expect(created.session.username).toBe(username);
    // Fourteen groups of four, as it is shown to be written down.
    expect(created.recovery_key).toMatch(/^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);

    const overview = await invokeTauri<SecurityOverview>(
      browserA,
      'account_security_status'
    );
    expect(overview).toEqual({
      authenticator: false,
      backup_codes: 0,
      recovery_key: true,
      session_verified: false
    });
  });

  it('turns two-factor sign-in on with a code from the authenticator', async function () {
    const setup = await invokeTauri<AuthenticatorSetup>(
      browserA,
      'account_begin_authenticator',
      { password, code: null }
    );
    expect(setup.url.startsWith('otpauth://totp/')).toBe(true);
    expect(setup.qr_svg).toContain('<svg');

    backupCodes = await invokeTauri<string[]>(
      browserA,
      'account_confirm_authenticator',
      { code: totpCode(setup.secret) }
    );
    expect(backupCodes).toHaveLength(10);

    const overview = await invokeTauri<SecurityOverview>(
      browserA,
      'account_security_status'
    );
    expect(overview.authenticator).toBe(true);
    // The device that set it up counts as having shown it.
    expect(overview.session_verified).toBe(true);
  });

  it('asks a second device for a code, and lets it in with one', async function () {
    await loginClient(browserB, {
      serverUrl: server,
      username,
      password,
      code: nextBackupCode()
    });

    const session = await invokeTauri<SessionInfo | null>(
      browserB,
      'etebase_session'
    );
    expect(session?.username).toBe(username);

    const devices = await invokeTauri<DeviceSession[]>(
      browserA,
      'account_sessions'
    );
    expect(devices).toHaveLength(2);
    expect(devices.filter((device) => device.current)).toHaveLength(1);
    expect(devices.every((device) => device.second_factor)).toBe(true);
    expect(devices[0].device_name).toContain('Mindstream Notes');
  });

  it('signs the second device out from the first, and the second says so', async function () {
    const devices = await invokeTauri<DeviceSession[]>(
      browserA,
      'account_sessions'
    );
    const other = devices.find((device) => !device.current);
    if (!other) throw new Error('the second device is not in the list');
    await invokeTauri(browserA, 'account_end_session', { id: other.id });

    await waitForSignedOut(browserB, 'its session was ended from device A');

    // It did not sign itself back in: the list still holds one device.
    const left = await invokeTauri<DeviceSession[]>(
      browserA,
      'account_sessions'
    );
    expect(left).toHaveLength(1);
    expect(left[0].current).toBe(true);

    const B = clientHelpers(browserB);
    await B.openNotifications();
    await waitForTextInPage(
      browserB.$('body'),
      'Signed out on this device',
      browserB
    );
  });

  it('signs every other device out when the password changes', async function () {
    await loginClient(browserB, {
      serverUrl: server,
      username,
      password,
      code: nextBackupCode()
    });

    await invokeTauri(browserA, 'account_change_password', {
      newPassword,
      code: nextBackupCode()
    });
    await waitForSignedOut(browserB, 'the password changed on device A');

    // The device that changed it carries on, and still syncs.
    const session = await invokeTauri<SessionInfo | null>(
      browserA,
      'etebase_session'
    );
    expect(session?.username).toBe(username);
    await invokeTauri(browserA, 'sync_now');

    // And the new password is the one that works now.
    await loginClient(browserB, {
      serverUrl: server,
      username,
      password: newPassword,
      code: nextBackupCode()
    });
    const again = await invokeTauri<SessionInfo | null>(
      browserB,
      'etebase_session'
    );
    expect(again?.username).toBe(username);
  });
});
