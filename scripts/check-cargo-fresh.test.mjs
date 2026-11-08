import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCargoFresh } from './check-cargo-fresh.mjs';

const artifact = (name, fresh) => ({
  reason: 'compiler-artifact',
  target: { name },
  fresh
});
const finished = { reason: 'build-finished', success: true };
const stream = (...messages) => messages.map(JSON.stringify).join('\n') + '\n';

test('unchanged build reuses every artifact, ignoring diagnostic messages', () => {
  assert.deepEqual(
    checkCargoFresh(
      stream(
        artifact('runtime', true),
        { reason: 'compiler-message' },
        artifact('app', true),
        finished
      )
    ),
    { artifacts: 2, rebuilt: 0 }
  );
});

test('a successful build still fails the reuse check when the app recompiles', () => {
  assert.throws(
    () =>
      checkCargoFresh(
        stream(artifact('runtime', true), artifact('app', false), finished)
      ),
    /recompiled: app/
  );
});

test('an incomplete or failed build cannot pass the reuse check', () => {
  assert.throws(
    () => checkCargoFresh(stream(artifact('app', true))),
    /did not finish/
  );
  assert.throws(
    () =>
      checkCargoFresh(
        stream(artifact('app', true), { ...finished, success: false })
      ),
    /did not finish/
  );
});

test('an empty artifact stream or invalid JSON cannot pass', () => {
  assert.throws(() => checkCargoFresh(stream(finished)), /no build artifacts/);
  assert.throws(() => checkCargoFresh('not JSON'), SyntaxError);
});
