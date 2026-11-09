import assert from 'node:assert/strict';
import { test } from 'node:test';
import { e2eRustBuildEnv, rustProfileVariables } from './build-profile.js';

test('E2E reduces linking work while retaining release runtime checks', () => {
  const env = e2eRustBuildEnv({});
  assert.equal(env.CARGO_PROFILE_RELEASE_LTO, 'off');
  assert.equal(env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS, '16');
  assert.equal(env.CARGO_PROFILE_RELEASE_OPT_LEVEL, '2');
  assert.equal(env.CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS, undefined);
  assert.equal(env.MINDSTREAM_BUNDLED_AOT, undefined);
  assert.deepEqual(Object.keys(env).sort(), [...rustProfileVariables].sort());
});

test('an explicit production comparison uses the checked-in release settings', () => {
  const source = {
    MINDSTREAM_E2E_PRODUCTION_PROFILE: '1',
    NODE_OPTIONS: 'example'
  };
  assert.deepEqual(e2eRustBuildEnv(source), source);
  assert.notEqual(e2eRustBuildEnv(source), source);
});

test('caller settings are preserved without mutating the environment', () => {
  const source = { CARGO_PROFILE_RELEASE_LTO: 'thin', NODE_OPTIONS: 'example' };
  const env = e2eRustBuildEnv(source);
  assert.equal(env.CARGO_PROFILE_RELEASE_LTO, 'thin');
  assert.equal(env.NODE_OPTIONS, 'example');
  assert.equal(source.CARGO_PROFILE_RELEASE_LTO, 'thin');
  assert.equal(Object.keys(source).length, 2);
});
