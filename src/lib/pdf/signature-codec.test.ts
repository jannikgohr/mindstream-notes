import { describe, expect, it } from 'vitest';
import { recordToSnapshot, snapshotToData } from './signature-codec';
import type { SignatureRecord } from '$lib/api/signatures';
import type { PdfSignatureSnapshot } from './types';

const record = (data: string): SignatureRecord => ({
  id: 'sig1',
  data,
  created: '2024-01-01',
  modified: '2024-01-01',
  pushed: false
});

const snapshot = (): PdfSignatureSnapshot => ({
  id: 'sig1',
  width: 200,
  height: 80,
  strokes: [{ id: 's1', color: '#000', width: 2, points: [{ x: 0, y: 0 }] }]
});

describe('recordToSnapshot', () => {
  it('decodes a valid geometry payload, taking the id from the record', () => {
    const data = JSON.stringify({
      width: 200,
      height: 80,
      strokes: [{ id: 's1', color: '#000', width: 2, points: [{ x: 0, y: 0 }] }]
    });
    expect(recordToSnapshot(record(data))).toEqual(snapshot());
  });

  it('returns null for malformed JSON', () => {
    expect(recordToSnapshot(record('not json'))).toBeNull();
  });

  it('returns null when there are no strokes', () => {
    expect(
      recordToSnapshot(
        record(JSON.stringify({ width: 1, height: 1, strokes: [] }))
      )
    ).toBeNull();
  });

  it('returns null when strokes is missing or not an array', () => {
    expect(
      recordToSnapshot(record(JSON.stringify({ width: 1, height: 1 })))
    ).toBeNull();
    expect(
      recordToSnapshot(record(JSON.stringify({ strokes: 'nope' })))
    ).toBeNull();
  });
});

describe('snapshotToData', () => {
  it('serialises geometry without the id', () => {
    const json = snapshotToData(snapshot());
    const parsed = JSON.parse(json);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed.width).toBe(200);
    expect(parsed.strokes).toHaveLength(1);
  });

  it('round-trips through recordToSnapshot', () => {
    const original = snapshot();
    const back = recordToSnapshot(record(snapshotToData(original)));
    expect(back).toEqual(original);
  });
});
