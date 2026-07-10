import { describe, expect, it } from 'vitest';
import {
  historySnapshotSize,
  parseHistorySnapshot,
  serializeYjsSnapshot
} from './snapshot';

describe('history snapshot codec', () => {
  it('keeps markdown snapshots as raw text', () => {
    const parsed = parseHistorySnapshot('# Title', 'markdown');

    expect(parsed).toEqual({
      noteKind: 'markdown',
      payloadKind: 'markdown',
      text: '# Title'
    });
  });

  it('round-trips yjs update snapshots for freeform notes', () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const encoded = serializeYjsSnapshot('freeform', bytes);
    const parsed = parseHistorySnapshot(encoded, 'freeform');

    expect(parsed.noteKind).toBe('freeform');
    expect(parsed.payloadKind).toBe('yjs-update');
    if (parsed.payloadKind === 'yjs-update') {
      expect(Array.from(parsed.bytes)).toEqual([0, 1, 2, 255]);
    }
  });

  it('round-trips yjs update snapshots for ink notes', () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const encoded = serializeYjsSnapshot('ink', bytes);
    const parsed = parseHistorySnapshot(encoded, 'ink');

    expect(parsed.noteKind).toBe('ink');
    expect(parsed.payloadKind).toBe('yjs-update');
    if (parsed.payloadKind === 'yjs-update') {
      expect(Array.from(parsed.bytes)).toEqual([4, 5, 6]);
    }
  });

  it('round-trips yjs update snapshots for PDF notes', () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const encoded = serializeYjsSnapshot('pdf', bytes);
    const parsed = parseHistorySnapshot(encoded, 'pdf');

    expect(parsed.noteKind).toBe('pdf');
    expect(parsed.payloadKind).toBe('yjs-update');
    if (parsed.payloadKind === 'yjs-update') {
      expect(Array.from(parsed.bytes)).toEqual([7, 8, 9]);
    }
  });

  it('treats invalid non-markdown payloads as empty snapshots', () => {
    const parsed = parseHistorySnapshot('not-json', 'freeform');

    expect(parsed.noteKind).toBe('freeform');
    expect(parsed.payloadKind).toBe('yjs-update');
    if (parsed.payloadKind === 'yjs-update') {
      expect(parsed.bytes.byteLength).toBe(0);
    }
  });

  it('measures snapshot size using Blob semantics', () => {
    const body = 'mindstream';
    expect(historySnapshotSize(body)).toBe(new Blob([body]).size);
  });
});
