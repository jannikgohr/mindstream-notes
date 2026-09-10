import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBundles } from './lint-i18n.mjs';

test('reports missing and additional nested keys', () => {
  assert.deepEqual(compareBundles({ a: { b: 'Hello' } }, { c: 'Hallo' }), [
    'a.b: missing translation',
    'c: extra translation'
  ]);
});
test('accepts reordered placeholders, rejects missing, renamed and duplicated ones', () => {
  assert.deepEqual(
    compareBundles({ a: '{name} has {count}' }, { a: '{count} hat {name}' }),
    []
  );
  for (const text of [
    '{name} hat',
    '{other} hat {count}',
    '{name} {name} {count}'
  ]) {
    assert.deepEqual(compareBundles({ a: '{name} has {count}' }, { a: text }), [
      'a: placeholder mismatch'
    ]);
  }
});
test('requires exact reviewed text for untranslated values', () => {
  assert.deepEqual(
    compareBundles({ a: 'Sync' }, { a: 'Sync' }, { a: 'Sync' }),
    []
  );
  assert.deepEqual(
    compareBundles({ a: 'Changed' }, { a: 'Changed' }, { a: 'Sync' }),
    ['a: identical text needs review']
  );
  assert.deepEqual(compareBundles({ a: 'Hello' }, { a: 'Hello' }), [
    'a: identical text needs review'
  ]);
});
test('rejects non-string values', () => {
  assert.deepEqual(compareBundles({ a: 'Hello' }, { a: 12 }), [
    'a: translation values must be strings'
  ]);
});
