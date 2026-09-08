import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createInkSaveController } from './save-controller';
import { flushPendingEditorSaves } from '$lib/editor/suspend-flush';

afterEach(() => vi.useRealTimers());

function update(doc: Y.Doc, text: string) {
  const before = Y.encodeStateVector(doc);
  doc.getText('body').insert(doc.getText('body').length, text);
  return Y.encodeStateAsUpdate(doc, before);
}

describe('Ink save controller', () => {
  it('merges queued updates and drains edits made during a save on teardown', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const restored = new Y.Doc();
    let release!: () => void;
    const persist = vi.fn(async (state: number[]) => {
      if (persist.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      Y.applyUpdate(restored, new Uint8Array(state));
    });
    const controller = createInkSaveController({
      canSave: () => true,
      encode: () => null,
      persist,
      onStatus: vi.fn()
    });
    controller.queue([update(doc, 'first')]);
    const first = controller.flush();
    controller.queue([update(doc, ' second')]);
    const closing = controller.destroy();
    doc.destroy();
    release();
    await Promise.all([first, closing]);
    expect(restored.getText('body').toString()).toBe('first second');
    expect(persist).toHaveBeenCalledTimes(2);
    restored.destroy();
  });

  it('rejects a reload flush on failure and retries the complete batch', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const restored = new Y.Doc();
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (state: number[]) => {
        Y.applyUpdate(restored, new Uint8Array(state));
      });
    const controller = createInkSaveController({
      canSave: () => true,
      encode: () => null,
      persist,
      onStatus: vi.fn()
    });
    const stop = controller.subscribeSuspend();
    controller.queue([update(doc, 'recover me')]);
    await expect(flushPendingEditorSaves()).rejects.toThrow('disk full');
    await flushPendingEditorSaves();
    expect(restored.getText('body').toString()).toBe('recover me');
    stop();
    await controller.destroy();
    doc.destroy();
    restored.destroy();
  });
});
