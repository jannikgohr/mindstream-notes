import { describe, expect, it } from 'vitest';
import { recordToSnapshot, snapshotToData } from './signature-codec';
import type { SignatureRecord } from '$lib/api/signatures';
import type { PdfSignatureSnapshot } from './types';

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

  it('preserves a valid transparent image payload', () => {
    const data = JSON.stringify({
      width: 200,
      height: 80,
      strokes: [
        { id: 's1', color: '#000', width: 2, points: [{ x: 0, y: 0 }] }
      ],
      image: {
        dataUrl: PNG_DATA_URL,
        width: 200,
        height: 80,
        mimeType: 'image/png'
      }
    });
    expect(recordToSnapshot(record(data))?.image).toEqual({
      dataUrl: PNG_DATA_URL,
      width: 200,
      height: 80,
      mimeType: 'image/png'
    });
  });

  it('drops malformed image payloads but keeps the stroke fallback', () => {
    const data = JSON.stringify({
      width: 200,
      height: 80,
      strokes: [
        { id: 's1', color: '#000', width: 2, points: [{ x: 0, y: 0 }] }
      ],
      image: {
        dataUrl: 'https://example.invalid/sig.png',
        width: 200,
        height: 80,
        mimeType: 'image/png'
      }
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

  it('returns null when the geometry envelope is not an object', () => {
    expect(recordToSnapshot(record('[]'))).toBeNull();
    expect(recordToSnapshot(record('"signature"'))).toBeNull();
    expect(recordToSnapshot(record('null'))).toBeNull();
  });

  it('returns null when dimensions are invalid', () => {
    expect(
      recordToSnapshot(
        record(JSON.stringify({ width: 0, height: 1, strokes: [{}] }))
      )
    ).toBeNull();
    expect(
      recordToSnapshot(
        record(JSON.stringify({ width: 1, height: Number.NaN, strokes: [{}] }))
      )
    ).toBeNull();
    expect(
      recordToSnapshot(
        record(JSON.stringify({ width: '1', height: 1, strokes: [{}] }))
      )
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
