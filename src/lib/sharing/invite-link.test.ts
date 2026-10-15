import { describe, expect, it } from 'vitest';
import written from '../../../protocol/links/invite-links.json';
import { parseInviteLink, sameServer, serverName } from './invite-link';

const SECRET = 'A'.repeat(43);

describe('parseInviteLink', () => {
  it('reads the server and the uid out of a link', () => {
    expect(
      parseInviteLink(`https://notes.example.com/join/AbC-123_xyz#${SECRET}`)
    ).toEqual({ serverUrl: 'https://notes.example.com/', uid: 'AbC-123_xyz' });
    expect(
      parseInviteLink(`http://localhost:3735/join/uid1#${SECRET}`)
    ).toEqual({ serverUrl: 'http://localhost:3735/', uid: 'uid1' });
  });

  it('keeps the path of a server that lives under one', () => {
    expect(
      parseInviteLink(`https://example.com/notes/join/uid1#${SECRET}`)
    ).toEqual({ serverUrl: 'https://example.com/notes/', uid: 'uid1' });
  });

  it('reads a link pasted with space around it', () => {
    expect(
      parseInviteLink(`  https://notes.example.com/join/uid1#${SECRET}\n`)?.uid
    ).toBe('uid1');
  });

  it('takes nothing else for a link', () => {
    for (const text of [
      '',
      'ABCD-EFGH-JKLM-NPQR',
      'hello there',
      // No secret, or one of the wrong length.
      'https://notes.example.com/join/uid1',
      'https://notes.example.com/join/uid1#',
      `https://notes.example.com/join/uid1#${SECRET.slice(4)}`,
      `https://notes.example.com/join/uid1#${SECRET}=`,
      // Not under `join/`, or with no uid.
      `https://notes.example.com/uid1#${SECRET}`,
      `https://notes.example.com/join/#${SECRET}`,
      `https://notes.example.com/rejoin/uid1#${SECRET}`,
      // Nothing a request should be made to.
      `mindstream://notes.example.com/join/uid1#${SECRET}`,
      `javascript:join/uid1#${SECRET}`
    ]) {
      expect(parseInviteLink(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe('serverName', () => {
  it('names a server by its host', () => {
    expect(serverName('https://notes.example.com/')).toBe('notes.example.com');
    expect(serverName('http://localhost:3735/')).toBe('localhost:3735');
    expect(serverName('https://example.com/notes/')).toBe('example.com/notes');
  });

  it('gives back what it cannot read', () => {
    expect(serverName('not a url')).toBe('not a url');
  });
});

describe('sameServer', () => {
  it('sees through the ways one address gets written', () => {
    for (const [one, other] of [
      ['https://notes.example.com', 'https://notes.example.com/'],
      ['https://Notes.Example.com/', 'https://notes.example.com'],
      ['https://notes.example.com:443/', 'https://notes.example.com/'],
      ['https://example.com/notes', 'https://example.com/notes/']
    ]) {
      expect(sameServer(one, other), `${one} / ${other}`).toBe(true);
    }
  });

  it('tells different servers apart', () => {
    for (const [one, other] of [
      ['https://notes.example.com/', 'https://other.example.com/'],
      ['https://notes.example.com/', 'http://notes.example.com/'],
      ['http://localhost:3735/', 'http://localhost:3736/'],
      ['https://example.com/', 'https://example.com.evil.test/'],
      ['not a url', 'https://example.com/'],
      ['', '']
    ]) {
      expect(sameServer(one, other), `${one} / ${other}`).toBe(false);
    }
  });
});

/**
 * The client library reads a link in Rust and this module reads it again in
 * the window, to react while someone types. protocol/links holds what both
 * have to make of the same text. The library's half is in `deep_links.rs`.
 */
describe('the links written down for every side', () => {
  it.each(written.links.valid)('reads $link', ({ link, server, uid }) => {
    expect(parseInviteLink(link)).toEqual({ serverUrl: server, uid });
  });

  it.each(written.links.invalid)('takes %j for no link', (text) => {
    expect(parseInviteLink(text)).toBeNull();
  });

  it('takes no address under the app scheme for a link either', () => {
    // Those are opened by the operating system and unwrapped in Rust. What
    // reaches the window is the link inside.
    for (const { address, link } of written.appAddresses.valid) {
      expect(parseInviteLink(address), address).toBeNull();
      expect(parseInviteLink(link), link).not.toBeNull();
    }
  });
});
