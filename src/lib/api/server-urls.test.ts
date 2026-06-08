import { describe, expect, it } from 'vitest';
import { getExcalidrawRoomUrl, getYjsRelayUrl } from './server-urls';

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

  it('strips trailing path / query / hash from the input', () => {
    expect(getYjsRelayUrl('https://collab.example.com/something?x=1#h')).toBe(
      'wss://collab.example.com/yjs'
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
  it('returns the origin of an https URL', () => {
    expect(getExcalidrawRoomUrl('https://collab.example.com/some/path')).toBe(
      'https://collab.example.com'
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
});
