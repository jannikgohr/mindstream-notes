import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from '@mindstream/plugin-sdk/testing';

test('inserts today in the window locale', async () => {
  const plugin = await loadPlugin('dist/package/plugin.wasm', {
    now: '2026-07-25T10:00:00Z',
    timeZone: 'UTC'
  });
  assert.deepEqual(await plugin.call('insertToday', { locale: 'de' }), {
    effect: 'insertMarkdown',
    markdown: 'Samstag, 25 Juli 2026'
  });
});
