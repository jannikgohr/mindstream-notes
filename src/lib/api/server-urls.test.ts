import { describe, expect, it } from 'vitest';
import {
  getExcalidrawRoomUrl,
  getServerHealthUrl,
  getYjsRelayUrl,
  normalizeServerUrl
} from './server-urls';

describe('getYjsRelayUrl', () => {
  it('rewrites https → wss and pins /yjs', () => {
    expect(getYjsRelayUrl('https://collab.example.com')).toBe(
      'wss://collab.example.com/yjs'
    );
  });

  it('rewrites http → ws for local dev', () => {
    expect(getYjsRelayUrl('http://localhost:8080')).toBe(
      'ws://localhost:8080/yjs'
    );
  });

  it('keeps a configured subpath and appends /yjs beneath it', () => {
    expect(getYjsRelayUrl('https://collab.example.com/something?x=1#h')).toBe(
      'wss://collab.example.com/something/yjs'
    );
  });

  it('trims whitespace', () => {
    expect(getYjsRelayUrl('  https://collab.example.com  ')).toBe(
      'wss://collab.example.com/yjs'
    );
  });

  it('returns empty string for empty / invalid input', () => {
    expect(getYjsRelayUrl('')).toBe('');
    expect(getYjsRelayUrl('   ')).toBe('');
    expect(getYjsRelayUrl('not a url')).toBe('');
  });
});

describe('getExcalidrawRoomUrl', () => {
  it('returns the configured base path of an https URL', () => {
    expect(getExcalidrawRoomUrl('https://collab.example.com/some/path')).toBe(
      'https://collab.example.com/some/path'
    );
  });

  it('returns the origin of an http URL with explicit port', () => {
    expect(getExcalidrawRoomUrl('http://localhost:8080')).toBe(
      'http://localhost:8080'
    );
  });

  it('returns empty string for empty / invalid input', () => {
    expect(getExcalidrawRoomUrl('')).toBe('');
    expect(getExcalidrawRoomUrl('not a url')).toBe('');
  });

  it('picks up the auto-scheme behaviour from normalizeServerUrl', () => {
    // Bare hostname used to silently disable collab here — it had no
    // scheme so `new URL(...)` threw and we collapsed to ''. The
    // normalize step prepends https:// first.
    expect(getExcalidrawRoomUrl('notes.example.com')).toBe(
      'https://notes.example.com'
    );
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
