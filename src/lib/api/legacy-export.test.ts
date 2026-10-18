import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import script from '../../../src-tauri/src/legacy-export.js?raw';

function exportDocument(storage: Map<string, string>, fail = false) {
  let mounted: (() => void) | undefined;
  const status = { textContent: '' };
  const invoke = vi.fn().mockResolvedValue(undefined);
  runInNewContext(script, {
    location: {
      pathname: '/legacy-browser-export.html',
      protocol: 'tauri:',
      host: 'localhost'
    },
    localStorage: {
      get length() {
        return storage.size;
      },
      key: (i: number) => {
        if (fail) throw new Error('synthetic private diagnostic');
        return [...storage.keys()][i];
      },
      getItem: (key: string) => storage.get(key) ?? null
    },
    window: { __TAURI_INTERNALS__: { invoke } },
    document: {
      readyState: 'loading',
      addEventListener: (_: string, listener: () => void) => {
        mounted = listener;
      },
      getElementById: () => status
    }
  });
  return { mount: () => mounted?.(), invoke, status };
}

it('captures raw unknown and malformed bytes before document scripts can change them', () => {
  const storage = new Map([
    ['__proto__', 'opaque raw plugin value'],
    ['notes-app:settings:v1:vault:unopened', '{malformed raw'],
    [
      'mindstream:collab-signing-key:v1:unopened-account',
      'synthetic private identity'
    ]
  ]);
  const page = exportDocument(storage);
  expect(page.invoke).not.toHaveBeenCalled();
  storage.set('notes-app:settings:v1:vault:unopened', '{}');
  page.mount();
  const [command, payload] = page.invoke.mock.calls[0];
  expect(command).toBe('finish_legacy_browser_export');
  expect(payload.origin).toBe('tauri://localhost');
  expect(payload.values['notes-app:settings:v1:vault:unopened']).toBe(
    '{malformed raw'
  );
  expect(payload.values.__proto__).toBe('opaque raw plugin value');
  expect(storage.get('mindstream:collab-signing-key:v1:unopened-account')).toBe(
    'synthetic private identity'
  );
});

it('reports unreadable storage as failure and displays no private error details', async () => {
  const storage = new Map([['private-key', 'synthetic private value']]);
  const page = exportDocument(storage, true);
  page.invoke.mockRejectedValue(new Error('synthetic private diagnostic'));
  page.mount();
  await Promise.resolve();
  expect(page.invoke).toHaveBeenCalledWith('finish_legacy_browser_export', {
    origin: 'tauri://localhost',
    values: null
  });
  expect(page.status.textContent).toContain('original data is retained');
  expect(page.status.textContent).not.toContain('synthetic private');
  expect(storage.size).toBe(1);
});
