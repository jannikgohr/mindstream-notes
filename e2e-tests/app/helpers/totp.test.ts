import assert from 'node:assert/strict';
import { test } from 'node:test';

import { base32Decode, totpCode } from './totp.js';

// The secret of RFC 6238's test vectors, "12345678901234567890", in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 reads the way a secret is shown', () => {
  assert.equal(base32Decode(RFC_SECRET).toString(), '12345678901234567890');
  assert.equal(
    base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq').toString(),
    '12345678901234567890'
  );
  assert.throws(() => base32Decode('GEZD1'), /not base32/);
});

test('codes match the vectors of RFC 6238, cut to six digits', () => {
  assert.equal(totpCode(RFC_SECRET, 59_000), '287082');
  assert.equal(totpCode(RFC_SECRET, 1_111_111_109_000), '081804');
  assert.equal(totpCode(RFC_SECRET, 1_234_567_890_000), '005924');
  assert.equal(totpCode(RFC_SECRET, 20_000_000_000_000), '353130');
});

test('a code holds for its thirty seconds and no longer', () => {
  const start = 1_800_000_000_000 - (1_800_000_000_000 % 30_000);
  assert.equal(
    totpCode(RFC_SECRET, start),
    totpCode(RFC_SECRET, start + 29_999)
  );
  assert.notEqual(
    totpCode(RFC_SECRET, start),
    totpCode(RFC_SECRET, start + 30_000)
  );
});
