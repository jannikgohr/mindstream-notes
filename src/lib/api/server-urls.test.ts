import { describe, expect, it } from 'vitest';
import {
  getRoomSocketUrl,
  getServerHealthUrl,
  normalizeServerUrl
} from './server-urls';

describe('getRoomSocketUrl', () => {
  it('names the room endpoint with a socket scheme', () => {
    expect(getRoomSocketUrl('https://notes.example.com')).toBe(
      'wss://notes.example.com/api/v1/room/'
    );
    expect(getRoomSocketUrl('http://localhost:8080')).toBe(
      'ws://localhost:8080/api/v1/room/'
    );
  });

  it('keeps a server behind a path where it is', () => {
    expect(getRoomSocketUrl('https://example.com/notes/?x=1#h')).toBe(
      'wss://example.com/notes/api/v1/room/'
    );
  });

  it('accepts the address as people type it', () => {
    expect(getRoomSocketUrl('  notes.example.com  ')).toBe(
      'wss://notes.example.com/api/v1/room/'
    );
  });

  it('returns empty when there is no usable server address', () => {
    expect(getRoomSocketUrl('')).toBe('');
    expect(getRoomSocketUrl('   ')).toBe('');
    expect(getRoomSocketUrl('not a url')).toBe('');
  });
});

describe('normalizeServerUrl', () => {
  it('returns empty + null error for empty input', () => {
    expect(normalizeServerUrl('')).toEqual({ url: '', error: null });
    expect(normalizeServerUrl('   ')).toEqual({ url: '', error: null });
  });

  it('prepends https:// for a bare hostname', () => {
    expect(normalizeServerUrl('notes.example.com')).toEqual({
      url: 'https://notes.example.com',
      error: null
    });
  });

  it('keeps an explicit scheme', () => {
    expect(normalizeServerUrl('http://localhost:8080')).toEqual({
      url: 'http://localhost:8080',
      error: null
    });
  });

  it('does not mistake `localhost:8080` for a URI scheme', () => {
    // `localhost:8080` parses as scheme `localhost` + path `8080`
    // under the bare URL constructor, which would silently swallow
    // the port. We special-case alpha-only schemes so this stays a
    // bare hostname and we prepend https://.
    expect(normalizeServerUrl('localhost:8080')).toEqual({
      url: 'https://localhost:8080',
      error: null
    });
  });

  it('strips trailing slash, query, and hash while preserving path', () => {
    expect(normalizeServerUrl('https://collab.example.com/')).toEqual({
      url: 'https://collab.example.com',
      error: null
    });
    expect(
      normalizeServerUrl('https://collab.example.com/some/path?x=1#h')
    ).toEqual({ url: 'https://collab.example.com/some/path', error: null });
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeServerUrl('  https://collab.example.com  ')).toEqual({
      url: 'https://collab.example.com',
      error: null
    });
  });

  it('rejects non-http(s) schemes', () => {
    const ftp = normalizeServerUrl('ftp://collab.example.com');
    expect(ftp.url).toBe('');
    expect(ftp.error).toMatch(/http/);
    const ws = normalizeServerUrl('ws://collab.example.com');
    expect(ws.url).toBe('');
    expect(ws.error).toMatch(/http/);
  });

  it('allows plain http only for local and private addresses', () => {
    for (const local of [
      'http://notes.localhost',
      'http://nas.local:3735',
      'http://nas.lan',
      'http://127.0.0.1:8080',
      'http://10.0.0.5',
      'http://172.16.1.1',
      'http://192.168.1.20/notes',
      'http://169.254.0.9',
      'http://100.101.102.103',
      'http://[::1]:8080',
      'http://[fd12::1]',
      'http://[fe80::1]',
      'http://[::ffff:192.168.0.1]'
    ]) {
      expect(normalizeServerUrl(local).error, local).toBeNull();
    }
    for (const remote of [
      'http://notes.example.com',
      'http://nas',
      'http://8.8.8.8',
      'http://172.32.0.1',
      'http://100.128.0.1',
      'http://[2001:db8::1]',
      'http://[::ffff:8.8.8.8]',
      'http://localhost.example.com',
      'http://nas.local.example.com',
      'http://example.lane'
    ]) {
      const r = normalizeServerUrl(remote);
      expect(r.url, remote).toBe('');
      expect(r.error, remote).toMatch(/https/);
    }
  });

  it('rejects unparseable input', () => {
    const r = normalizeServerUrl('not a url');
    expect(r.url).toBe('');
    expect(r.error).toBeTruthy();
  });
});

describe('getServerHealthUrl', () => {
  it('appends /healthz at the origin', () => {
    expect(getServerHealthUrl('https://collab.example.com')).toBe(
      'https://collab.example.com/healthz'
    );
  });

  it('appends /healthz beneath a configured subpath', () => {
    expect(getServerHealthUrl('https://collab.example.com/mindstream')).toBe(
      'https://collab.example.com/mindstream/healthz'
    );
  });
});
