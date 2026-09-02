import { describe, expect, it } from 'vitest';
import { CommandErrorCode } from './core';
import { isCommandError, toErrorMessage } from './errors';

describe('toErrorMessage', () => {
  it('reads the message off a Tauri CommandError rejection', () => {
    // The regression this helper exists for: Tauri rejects commands with
    // a plain `{ code, message }` object, and `String(err)` on that
    // rendered "[object Object]" under the Sync now button.
    const rejection = {
      code: CommandErrorCode.InvalidArgument,
      message: 'sync session expired — sign out and sign in again to reconnect'
    };
    expect(toErrorMessage(rejection)).toBe(
      'sync session expired — sign out and sign in again to reconnect'
    );
    expect(toErrorMessage(rejection)).not.toBe('[object Object]');
  });

  it('handles Errors, strings and message-bearing objects', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('plain string')).toBe('plain string');
    expect(toErrorMessage({ message: 'bare message' })).toBe('bare message');
  });

  it('falls back to JSON for objects with no message', () => {
    expect(toErrorMessage({ status: 401 })).toBe('{"status":401}');
  });

  it('survives cyclic objects and primitives', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Must not throw — a catch site rendering an error is the last place
    // that can afford to throw again.
    expect(() => toErrorMessage(cyclic)).not.toThrow();
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
    expect(toErrorMessage(42)).toBe('42');
  });
});

describe('isCommandError', () => {
  it('needs both a string code and a string message', () => {
    expect(
      isCommandError({ code: CommandErrorCode.Database, message: 'nope' })
    ).toBe(true);
    expect(isCommandError({ message: 'no code' })).toBe(false);
    expect(isCommandError({ code: 'no message' })).toBe(false);
    expect(isCommandError(new Error('boom'))).toBe(false);
    expect(isCommandError(null)).toBe(false);
  });
});
