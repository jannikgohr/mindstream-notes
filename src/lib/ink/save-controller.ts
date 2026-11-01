import * as Y from 'yjs';
import type { RecoveryAcknowledgement } from '$lib/browser/recovery';
import { createSaveScheduler } from '$lib/editor/save-scheduler';

export function createInkSaveController(options: {
  canSave: () => boolean;
  checkpoint?: () => void;
  captureAcknowledgement?: () => RecoveryAcknowledgement;
  encode: () => Uint8Array | null;
  persist: (state: number[], recoveryToken?: string) => Promise<void>;
  onStatus: (status: 'pending' | 'saving' | 'saved' | 'error') => void;
}) {
  let updates: Uint8Array[] = [];
  let closed = false;
  const scheduler = createSaveScheduler({
    canSave: options.canSave,
    checkpoint: options.checkpoint,
    onError: () => options.onStatus('error'),
    capture: captureSave
  });

  function captureSave(): (() => Promise<void>) | null {
    if (!options.canSave() || updates.length === 0) return null;
    const batch = updates;
    updates = [];
    const state = Array.from(Y.mergeUpdates(batch));
    const acknowledge = options.captureAcknowledgement?.();
    return async () => {
      options.onStatus('saving');
      try {
        await options.persist(state, acknowledge?.token);
        acknowledge?.();
        options.onStatus(updates.length ? 'pending' : 'saved');
      } catch (error) {
        updates = [...batch, ...updates];
        options.onStatus('error');
        console.warn('[ink-canvas] failed to save note', error);
        throw error;
      } finally {
        if (updates.length && !closed) scheduler.schedule();
      }
    };
  }
  function queue(batch: Uint8Array[]) {
    if (closed || !options.canSave()) return;
    updates.push(...batch.filter((update) => update.byteLength > 0));
    if (!updates.length) return;
    options.onStatus('pending');
    scheduler.schedule();
  }
  return {
    queue,
    schedule() {
      const state = options.encode();
      if (state) queue([state]);
    },
    flush: scheduler.flush,
    subscribeSuspend: scheduler.subscribeSuspend,
    destroy() {
      closed = true;
      return scheduler.destroy();
    }
  };
}
