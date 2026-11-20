import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args)
}));

import { handOverUndoHistories, retainUndoOnUnload } from './retained-undo';

describe('retained undo', () => {
  beforeEach(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    mocks.invoke.mockImplementation(async () => null);
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
});
