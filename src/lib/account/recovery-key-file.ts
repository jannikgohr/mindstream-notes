/**
 * The text of the file a recovery key can be saved to.
 *
 * The key alone would do. But a file found a year later, with a row of
 * letters in it and nothing else, is a riddle. So the file says what it is,
 * which account it is for and when it was made, in the user's language.
 */

import type { SecretFile } from '$lib/api/account';
import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';

/** Where the key belongs. A session has both, right after sign-up too. */
export interface KeyOwner {
  username: string;
  server_url: string;
}

export function recoveryKeyFile(
  key: string,
  owner: KeyOwner | null,
  now: Date = new Date()
): SecretFile {
  const lines = [tUi('account.reveal.file.heading'), ''];
  if (owner) {
    lines.push(
      tUiFormat('account.reveal.file.account', { username: owner.username }),
      tUiFormat('account.reveal.file.server', { server: owner.server_url })
    );
  }
  lines.push(
    tUiFormat('account.reveal.file.saved', {
      date: now.toISOString().slice(0, 10)
    }),
    '',
    key,
    '',
    tUi('account.reveal.file.note'),
    ''
  );
  return {
    title: tUi('account.reveal.file.dialogTitle'),
    kind: tUi('account.reveal.file.kind'),
    // The Rust side cleans the name whatever a username holds.
    suggestedName: owner
      ? `mindstream-recovery-key-${owner.username}.txt`
      : 'mindstream-recovery-key.txt',
    contents: lines.join('\n')
  };
}
