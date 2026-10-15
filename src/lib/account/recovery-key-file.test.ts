import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '$lib/settings/i18n.svelte';
import { recoveryKeyFile } from './recovery-key-file';

const KEY = 'ABCD-EFGH-IJKL-MNOP';
const OWNER = { username: 'ann', server_url: 'https://notes.example.test/' };
const DAY = new Date('2026-10-13T21:30:00Z');

afterEach(() => setLanguage('en'));

describe('recoveryKeyFile', () => {
  it('says what it is, whose it is and when, and holds the key on a line of its own', () => {
    const file = recoveryKeyFile(KEY, OWNER, DAY);
    const lines = file.contents.split('\n');
    expect(lines[0]).toBe('Mindstream Notes recovery key');
    expect(lines).toContain('Account: ann');
    expect(lines).toContain('Server: https://notes.example.test/');
    expect(lines).toContain('Saved on: 2026-10-13');
    expect(lines).toContain(KEY);
    expect(file.contents).toMatch(/only you can reach/);
    expect(file.contents).not.toMatch(/\{\w+\}/);
    expect(file.suggestedName).toBe('mindstream-recovery-key-ann.txt');
    expect(file.title).toBe('Save your recovery key');
    expect(file.kind).toBe('Text file');
  });

  it('does without the account when there is no session to name', () => {
    const file = recoveryKeyFile(KEY, null, DAY);
    expect(file.contents).toContain(KEY);
    expect(file.contents).not.toContain('Account:');
    expect(file.suggestedName).toBe('mindstream-recovery-key.txt');
  });

  it('is written in the language of the app', () => {
    setLanguage('de');
    const file = recoveryKeyFile(KEY, OWNER, DAY);
    expect(file.contents).toContain('Konto: ann');
    expect(file.contents).toContain(KEY);
    expect(file.contents).not.toMatch(/\{\w+\}/);
    expect(file.title).toBe('Wiederherstellungsschlüssel speichern');
  });
});
