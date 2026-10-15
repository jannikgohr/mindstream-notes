/**
 * Account security bridge. Mirror of src-tauri/src/auth/account.rs.
 *
 * Signing up, getting back in with a recovery key, the second factor, the
 * password and the list of signed-in devices. Everything here needs the
 * desktop or mobile app: outside Tauri there is no session to act on.
 *
 * A refusal arrives as a `CommandError` with code `refused` and a `reason`.
 * `$lib/account/refusal` turns the reason into a sentence.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { flushPendingEditorSaves } from '$lib/editor/suspend-flush';
import { assertRequiredString } from '$lib/validation';
import type { ServerType, SessionInfo } from './auth.svelte';
import {
  assertBoolean,
  assertNumber,
  assertRecord,
  assertString,
  assertStringArray,
  assertVoid,
  TauriCommandName,
  isTauri
} from './core';

/** Who may create an account on a server. */
export type SignupPolicy = 'open' | 'invite' | 'closed';

export interface ServerInfo {
  signup: SignupPolicy;
  protocol: number;
  version: string;
}

export interface ServerTarget {
  serverType: ServerType;
  serverUrl?: string;
}

export interface SignupInput extends ServerTarget {
  username: string;
  email: string;
  password: string;
  /** From the server's administrator, where signup is not open. */
  signupCode?: string;
  /**
   * Or an invite link whose maker let it create an account. The account is
   * made on the link's server and then joins what the link leads to.
   */
  inviteLink?: string;
}

export interface RecoverInput extends ServerTarget {
  username: string;
  recoveryKey: string;
  newPassword: string;
  /** From the authenticator, where the account has one. */
  code?: string;
}

/** A session opened by signing up or recovering, and the recovery key that
 *  came with it. The key cannot be fetched again. */
export interface NewAccount {
  session: SessionInfo;
  recoveryKey: string;
}

export interface SecurityOverview {
  authenticator: boolean;
  /** Backup codes not yet used. */
  backupCodes: number;
  recoveryKey: boolean;
  /** Whether this device signed in with a second factor. One that did may
   *  replace the authenticator on the password alone. */
  sessionVerified: boolean;
}

export interface AuthenticatorSetup {
  /** The secret as an authenticator app takes it when typed in. */
  secret: string;
  /** The same as an `otpauth:` link. */
  url: string;
  /** The link as a QR code, an SVG document. */
  qrSvg: string;
}

export interface DeviceSession {
  id: number;
  deviceName: string;
  /** Seconds since 1970. */
  createdAt: number;
  /** Accurate to a few minutes. */
  lastUsedAt: number;
  secondFactor: boolean;
  /** The device asking. */
  current: boolean;
}

function requireApp(): void {
  if (!isTauri()) {
    throw new Error('Accounts are only available in the app.');
  }
}

/** A field left empty is sent as nothing at all. */
function orNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function targetArgs(target: ServerTarget): Record<string, string | null> {
  if (target.serverType === 'self-hosted') {
    assertRequiredString(target.serverUrl ?? '', 'serverUrl');
  }
  return {
    server_type: target.serverType,
    server_url: target.serverUrl ?? null
  };
}

export async function accountServerInfo(
  target: ServerTarget
): Promise<ServerInfo> {
  requireApp();
  const args = targetArgs(target);
  return parseServerInfo(
    await tauriInvoke<unknown>(TauriCommandName.AccountServerInfo, {
      serverType: args.server_type,
      serverUrl: args.server_url
    })
  );
}

export async function accountSignup(input: SignupInput): Promise<NewAccount> {
  requireApp();
  assertRequiredString(input.username, 'input.username');
  assertRequiredString(input.password, 'input.password');
  await flushPendingEditorSaves();
  return parseNewAccount(
    await tauriInvoke<unknown>(TauriCommandName.AccountSignup, {
      args: {
        ...targetArgs(input),
        username: input.username,
        email: input.email,
        password: input.password,
        signup_code: orNull(input.signupCode),
        invite_link: orNull(input.inviteLink)
      }
    })
  );
}

export async function accountRecover(input: RecoverInput): Promise<NewAccount> {
  requireApp();
  assertRequiredString(input.username, 'input.username');
  assertRequiredString(input.recoveryKey, 'input.recoveryKey');
  assertRequiredString(input.newPassword, 'input.newPassword');
  await flushPendingEditorSaves();
  return parseNewAccount(
    await tauriInvoke<unknown>(TauriCommandName.AccountRecover, {
      args: {
        ...targetArgs(input),
        username: input.username,
        recovery_key: input.recoveryKey,
        new_password: input.newPassword,
        code: orNull(input.code)
      }
    })
  );
}

export async function accountSecurityStatus(): Promise<SecurityOverview> {
  requireApp();
  return parseSecurityOverview(
    await tauriInvoke<unknown>(TauriCommandName.AccountSecurityStatus)
  );
}

export async function accountBeginAuthenticator(
  password: string,
  code?: string
): Promise<AuthenticatorSetup> {
  requireApp();
  assertRequiredString(password, 'password');
  return parseAuthenticatorSetup(
    await tauriInvoke<unknown>(TauriCommandName.AccountBeginAuthenticator, {
      password,
      code: orNull(code)
    })
  );
}

/** Returns the backup codes, which are shown once. */
export async function accountConfirmAuthenticator(
  code: string
): Promise<string[]> {
  requireApp();
  assertRequiredString(code, 'code');
  return assertStringArray(
    await tauriInvoke<unknown>(TauriCommandName.AccountConfirmAuthenticator, {
      code
    }),
    'backup codes'
  );
}

export async function accountRemoveAuthenticator(
  password: string,
  code: string
): Promise<void> {
  requireApp();
  assertRequiredString(password, 'password');
  assertRequiredString(code, 'code');
  assertVoid(
    await tauriInvoke<unknown>(TauriCommandName.AccountRemoveAuthenticator, {
      password,
      code
    }),
    'account_remove_authenticator response'
  );
}

export async function accountNewBackupCodes(
  password: string,
  code: string
): Promise<string[]> {
  requireApp();
  assertRequiredString(password, 'password');
  assertRequiredString(code, 'code');
  return assertStringArray(
    await tauriInvoke<unknown>(TauriCommandName.AccountNewBackupCodes, {
      password,
      code
    }),
    'backup codes'
  );
}

/** Returns the new recovery key. The old one stops working. */
export async function accountNewRecoveryKey(
  password: string,
  code?: string
): Promise<string> {
  requireApp();
  assertRequiredString(password, 'password');
  return assertString(
    await tauriInvoke<unknown>(TauriCommandName.AccountNewRecoveryKey, {
      password,
      code: orNull(code)
    }),
    'recovery key'
  );
}

export async function accountChangePassword(
  newPassword: string,
  code?: string
): Promise<void> {
  requireApp();
  assertRequiredString(newPassword, 'newPassword');
  assertVoid(
    await tauriInvoke<unknown>(TauriCommandName.AccountChangePassword, {
      newPassword,
      code: orNull(code)
    }),
    'account_change_password response'
  );
}

/** A secret to keep in a file, and what the save dialog says about it. */
export interface SecretFile {
  /** The save dialog's title. */
  title: string;
  /** What the dialog calls the kind of file. */
  kind: string;
  suggestedName: string;
  contents: string;
}

/**
 * Ask the user where to keep a secret they were just shown, and write it
 * there. Resolves to false when they close the dialog without choosing.
 */
export async function accountSaveSecretFile(
  file: SecretFile
): Promise<boolean> {
  requireApp();
  assertRequiredString(file.contents, 'file.contents');
  return assertBoolean(
    await tauriInvoke<unknown>(TauriCommandName.AccountSaveSecretFile, {
      input: {
        title: file.title,
        kind: file.kind,
        suggested_name: file.suggestedName,
        contents: file.contents
      }
    }),
    'account_save_secret_file response'
  );
}

export async function accountSessions(): Promise<DeviceSession[]> {
  requireApp();
  const value = await tauriInvoke<unknown>(TauriCommandName.AccountSessions);
  if (!Array.isArray(value)) throw new Error('devices must be an array');
  return value.map(parseDeviceSession);
}

export async function accountEndSession(id: number): Promise<void> {
  requireApp();
  assertVoid(
    await tauriInvoke<unknown>(TauriCommandName.AccountEndSession, { id }),
    'account_end_session response'
  );
}

export async function accountEndOtherSessions(): Promise<void> {
  requireApp();
  assertVoid(
    await tauriInvoke<unknown>(TauriCommandName.AccountEndOtherSessions),
    'account_end_other_sessions response'
  );
}

function parseSignupPolicy(value: unknown): SignupPolicy {
  const policy = assertString(value, 'server info.signup');
  // A policy this app has not heard of is treated as the strictest one, so
  // the form asks for a code instead of promising a signup that fails.
  return policy === 'open' || policy === 'invite' ? policy : 'closed';
}

function parseServerInfo(value: unknown): ServerInfo {
  const raw = assertRecord(value, 'server info');
  return {
    signup: parseSignupPolicy(raw.signup),
    protocol: assertNumber(raw.protocol, 'server info.protocol'),
    version: assertString(raw.version, 'server info.version')
  };
}

function parseNewAccount(value: unknown): NewAccount {
  const raw = assertRecord(value, 'new account');
  const session = assertRecord(raw.session, 'new account.session');
  return {
    session: {
      username: assertString(session.username, 'new account.session.username'),
      server_url: assertString(
        session.server_url,
        'new account.session.server_url'
      )
    },
    recoveryKey: assertString(raw.recovery_key, 'new account.recovery_key')
  };
}

function parseSecurityOverview(value: unknown): SecurityOverview {
  const raw = assertRecord(value, 'account security');
  return {
    authenticator: assertBoolean(
      raw.authenticator,
      'account security.authenticator'
    ),
    backupCodes: assertNumber(
      raw.backup_codes,
      'account security.backup_codes'
    ),
    recoveryKey: assertBoolean(
      raw.recovery_key,
      'account security.recovery_key'
    ),
    sessionVerified: assertBoolean(
      raw.session_verified,
      'account security.session_verified'
    )
  };
}

function parseAuthenticatorSetup(value: unknown): AuthenticatorSetup {
  const raw = assertRecord(value, 'authenticator setup');
  return {
    secret: assertString(raw.secret, 'authenticator setup.secret'),
    url: assertString(raw.url, 'authenticator setup.url'),
    qrSvg: assertString(raw.qr_svg, 'authenticator setup.qr_svg')
  };
}

function parseDeviceSession(value: unknown, index: number): DeviceSession {
  const context = `devices[${index}]`;
  const raw = assertRecord(value, context);
  return {
    id: assertNumber(raw.id, `${context}.id`),
    deviceName: assertString(raw.device_name, `${context}.device_name`),
    createdAt: assertNumber(raw.created_at, `${context}.created_at`),
    lastUsedAt: assertNumber(raw.last_used_at, `${context}.last_used_at`),
    secondFactor: assertBoolean(raw.second_factor, `${context}.second_factor`),
    current: assertBoolean(raw.current, `${context}.current`)
  };
}
