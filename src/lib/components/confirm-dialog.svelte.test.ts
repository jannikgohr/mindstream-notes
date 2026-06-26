import { beforeEach, describe, expect, it } from 'vitest';
import { alert, confirm, confirmQueue } from './confirm-dialog.svelte';

beforeEach(() => {
  confirmQueue.items = [];
});

describe('confirm', () => {
  it('enqueues a pending confirm and resolves with the decision', async () => {
    const p = confirm({ title: 'Delete?', destructive: true });
    expect(confirmQueue.items).toHaveLength(1);
    expect(confirmQueue.items[0].title).toBe('Delete?');
    expect(confirmQueue.items[0].destructive).toBe(true);

    confirmQueue.items[0].resolve(true);
    await expect(p).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const p = confirm({ title: 'Proceed?' });
    confirmQueue.items[0].resolve(false);
    await expect(p).resolves.toBe(false);
  });

  it('queues concurrent calls in order', () => {
    void confirm({ title: 'first' });
    void confirm({ title: 'second' });
    expect(confirmQueue.items.map((i) => i.title)).toEqual(['first', 'second']);
  });

  it('carries confirmDelaySeconds through to the queued item', () => {
    void confirm({ title: 'Delete vault?', confirmDelaySeconds: 3 });
    expect(confirmQueue.items[0].confirmDelaySeconds).toBe(3);
  });
});

describe('alert', () => {
  it('enqueues an info-only dialog that resolves void on dismiss', async () => {
    const p = alert({ title: 'Up to date' });
    const pending = confirmQueue.items[0];
    expect(pending.infoOnly).toBe(true);
    pending.resolve(true);
    await expect(p).resolves.toBeUndefined();
  });
});
