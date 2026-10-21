import { describe, expect, it } from 'vitest';
import { CommandErrorCode } from '$lib/api/core';
import { toasts } from '$lib/components/toast.svelte';
import de from '$lib/settings/i18n/de.json';
import en from '$lib/settings/i18n/en.json';
import {
  describeRefusal,
  REASON_CODE_REQUIRED,
  REFUSAL_UI_KEYS,
  refusalReason,
  toastRefusal
} from './refusal';

function refused(reason: string, message = 'in the words of the server') {
  return { code: CommandErrorCode.Refused, message, reason };
}

describe('refusalReason', () => {
  it('reads the reason off a refusal', () => {
    expect(refusalReason(refused('totp_required'))).toBe(REASON_CODE_REQUIRED);
  });

  it('is null for every other kind of failure', () => {
    expect(
      refusalReason({ code: CommandErrorCode.Io, message: 'disk full' })
    ).toBeNull();
    // A reason on an error that is not a refusal is not acted on.
    expect(
      refusalReason({
        code: CommandErrorCode.Unknown,
        message: 'x',
        reason: 'totp_required'
      })
    ).toBeNull();
    expect(refusalReason(new Error('boom'))).toBeNull();
    expect(refusalReason('boom')).toBeNull();
    expect(refusalReason(null)).toBeNull();
  });
});

describe('describeRefusal', () => {
  it('says a known reason in the words of the app', () => {
    expect(describeRefusal(refused('login_bad_signature'))).toBe(
      'Wrong password.'
    );
    expect(describeRefusal(refused('unreachable'))).toMatch(/reach the server/);
  });

  it('has a sentence for each way an invite link can fail', () => {
    expect(describeRefusal(refused('link_used'))).toBe(
      'This link has been used up.'
    );
    expect(describeRefusal(refused('link_expired'))).toBe(
      'This link has expired.'
    );
    for (const reason of [
      'link_invalid',
      'link_other_server',
      'already_member',
      'too_many_links'
    ]) {
      expect(describeRefusal(refused(reason)), reason).not.toBe(
        'in the words of the server'
      );
    }
  });

  it('has a sentence for each limit a dialog can run into', () => {
    expect(describeRefusal(refused('member_limit'))).toBe(
      "This folder has as many members as its owner's plan allows."
    );
    expect(describeRefusal(refused('space_limit'))).toMatch(
      /no more shared folders/
    );
    for (const reason of ['storage_full', 'item_too_large', 'plan_lapsed']) {
      expect(describeRefusal(refused(reason)), reason).not.toBe(
        'in the words of the server'
      );
    }
  });

  it('passes on the message for a reason it has no sentence for', () => {
    expect(
      describeRefusal(refused('bad_request', 'sign up: Malformed email.'))
    ).toBe('sign up: Malformed email.');
  });

  it('describes anything else the usual way', () => {
    expect(describeRefusal(new Error('boom'))).toBe('boom');
    expect(
      describeRefusal({ code: CommandErrorCode.Task, message: 'task died' })
    ).toBe('task died');
  });
});

describe('toastRefusal', () => {
  it('shows a refusal and throws anything else on', () => {
    const before = toasts.items.length;
    toastRefusal(refused('demo_note_not_shareable'));
    expect(toasts.items.at(-1)).toMatchObject({
      variant: 'error',
      message: expect.stringMatching(/shared folder/)
    });
    const failure = new Error('disk full');
    expect(() => toastRefusal(failure)).toThrow(failure);
    expect(toasts.items).toHaveLength(before + 1);
  });
});

describe('the sentences', () => {
  it.each(REFUSAL_UI_KEYS)('%s is in both bundles', (key) => {
    expect((en.ui as Record<string, string>)[key]).toBeTruthy();
    expect((de.ui as Record<string, string>)[key]).toBeTruthy();
  });
});
