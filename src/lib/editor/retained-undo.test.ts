import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args)
}));

import { handOverUndoHistories, retainUndoOnUnload } from './retained-undo';

/** A browser tab with its own sessionStorage, and a fresh module graph. */
function browserTab(onSet: (key: string, value: string) => void) {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.resetModules();
  const items = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      onSet(key, value);
      items.set(key, value);
    },
    removeItem: (key: string) => items.delete(key)
  });
  return items;
}

function hideTab() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('retained undo', () => {
  beforeEach(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    mocks.invoke.mockImplementation(async () => null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('replaces the last handoff even when nothing is left to keep', async () => {
    const release = retainUndoOnUnload('markdown:a', () => ({ done: 1 }));
    await handOverUndoHistories();
    release();
    // That unload was cancelled; the editor has closed since.
    await handOverUndoHistories();

    const handed = mocks.invoke.mock.calls
      .filter(([command]) => command === 'retain_undo_history')
      .map(([, args]) => (args as { history: string }).history);
    expect(handed).toEqual(['{"markdown:a":{"done":1}}', '{}']);
  });

  it("keeps a browser tab's histories for the reload after a discard", async () => {
    let written!: () => void;
    const wrote = new Promise<void>((resolve) => (written = resolve));
    const items = browserTab(() => written());
    const tab = await import('./retained-undo');
    const stop = tab.retainUndoWhileHidden();
    tab.retainUndoOnUnload('markdown:a', () => ({ done: 1 }));
    hideTab();
    await wrote;
    stop();
    expect(items.get('mindstream:undo-history')).toBe(
      '{"markdown:a":{"done":1}}'
    );

    vi.resetModules();
    const reloaded = await import('./retained-undo');
    expect(await reloaded.takeRetainedUndo('markdown:a')).toEqual({ done: 1 });
  });

  it('drops the last handoff when the new one does not fit', async () => {
    const items = browserTab(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    items.set('mindstream:undo-history', '{"markdown:a":{"done":1}}');
    const tab = await import('./retained-undo');
    const stop = tab.retainUndoWhileHidden();
    tab.retainUndoOnUnload('markdown:a', () => ({ done: 2 }));
    const warned = new Promise<void>((resolve) =>
      vi.spyOn(console, 'warn').mockImplementationOnce(() => resolve())
    );
    hideTab();
    await warned;
    stop();
    expect(items.has('mindstream:undo-history')).toBe(false);
  });
});
