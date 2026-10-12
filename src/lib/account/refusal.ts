/**
 * What to tell the user when the sync server says no.
 *
 * The Rust side hands over the server's reason as a fixed word, see
 * `refusal` in src-tauri/src/auth/account.rs. The ones a person can act on
 * get a sentence of their own here, in the app's language. Anything else
 * falls back to the message that came with the error, which is the server's
 * own English.
 */

import { CommandErrorCode } from '$lib/api/core';
import { isCommandError, toErrorMessage } from '$lib/api/errors';
import { tUi } from '$lib/settings/i18n.svelte';

/** Reasons with a translated sentence. The key is the reason itself, the
 *  value the `ui` entry that holds the sentence. */
const SENTENCES: Record<string, string> = {
  totp_required: 'account.refusal.codeRequired',
  totp_invalid: 'account.refusal.codeInvalid',
  totp_throttled: 'account.refusal.codeThrottled',
  totp_not_enabled: 'account.refusal.noAuthenticator',
  totp_not_started: 'account.refusal.setupNotStarted',
  throttled: 'account.refusal.throttled',
  login_bad_signature: 'account.refusal.wrongPassword',
  recovery_bad_signature: 'account.refusal.wrongRecoveryKey',
  recovery_key_malformed: 'account.refusal.notARecoveryKey',
  recovery_expired: 'account.refusal.recoveryExpired',
  recovery_used: 'account.refusal.recoveryUsed',
  user_not_found: 'account.refusal.unknownUser',
  user_exists: 'account.refusal.userExists',
  user_inactive: 'account.refusal.userDisabled',
  signup_closed: 'account.refusal.signupClosed',
  signup_invitation_invalid: 'account.refusal.signupCodeInvalid',
  authentication_failed: 'account.refusal.sessionEnded',
  not_signed_in: 'account.refusal.sessionEnded',
  unreachable: 'account.refusal.unreachable',
  not_a_mindstream_server: 'account.refusal.notAServer'
};

/** The server wants a code from the authenticator before it goes on. */
export const REASON_CODE_REQUIRED = 'totp_required';
/** The code sent was wrong or already used. */
export const REASON_CODE_INVALID = 'totp_invalid';

/** The reason the server gave, or null for any other kind of failure. */
export function refusalReason(err: unknown): string | null {
  if (!isCommandError(err) || err.code !== CommandErrorCode.Refused) {
    return null;
  }
  return typeof err.reason === 'string' ? err.reason : null;
}

/** A sentence for whatever went wrong, translated where the reason is one
 *  this app knows. */
export function describeRefusal(err: unknown): string {
  const reason = refusalReason(err);
  const key = reason === null ? undefined : SENTENCES[reason];
  return key === undefined ? toErrorMessage(err) : tUi(key);
}

/** Every `ui` key this module can ask for, so a test can check the bundles
 *  have them all. */
export const REFUSAL_UI_KEYS: readonly string[] = [
  ...new Set(Object.values(SENTENCES))
];
