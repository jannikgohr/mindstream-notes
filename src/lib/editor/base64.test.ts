import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';

const decode = (b64: string) => Array.from(base64ToBytes(b64));

describe('base64ToBytes', () => {
  it('round-trips bytes across the encoder chunk boundary', () => {
    const bytes = Uint8Array.from({ length: 0x8000 + 37 }, (_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
  it('decodes standard base64', () => {
    // "Man" -> TWFu
    expect(decode('TWFu')).toEqual([77, 97, 110]);
  });

  it('decodes without padding by re-padding internally', () => {
    // "Ma" -> TWE= ; supplying the unpadded "TWE" must still work.
    expect(decode('TWE')).toEqual([77, 97]);
  });

  it('decodes URL-safe base64 (- and _)', () => {
    // bytes [251, 255] encode to "+/8=" standard, "-_8" url-safe.
    expect(decode('-_8')).toEqual([251, 255]);
  });

  it('returns an empty array for an empty string', () => {
    expect(decode('')).toEqual([]);
  });
});
