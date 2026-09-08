import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSaveScheduler, SAVE_DEBOUNCE_MS } from './save-scheduler';
import { flushPendingEditorSaves } from './suspend-flush';

describe('save scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('debounces edits and clears pending after saving', async () => {
    const save = vi.fn(async () => {});
    const scheduler = createSaveScheduler({ canSave: () => true, save });
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
  });
  it('rechecks trash or read-only status when the timer fires', async () => {
    let writable = true;
    const save = vi.fn(async () => {});
    const scheduler = createSaveScheduler({ canSave: () => writable, save });
    scheduler.schedule();
    writable = false;
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await scheduler.destroy();
    expect(save).not.toHaveBeenCalled();
  });
  it('flushes once for duplicate suspend events and removes subscriptions', async () => {
    const save = vi.fn(async () => {});
    const scheduler = createSaveScheduler({ canSave: () => true, save });
    const stop = scheduler.subscribeSuspend();
    scheduler.schedule();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    stop();
    scheduler.schedule();
    await flushPendingEditorSaves();
    expect(save).toHaveBeenCalledTimes(1);
    scheduler.cancel();
  });
  it('captures before destroy returns and never schedules after teardown', async () => {
    const save = vi.fn(async () => {});
    const scheduler = createSaveScheduler({ canSave: () => true, save });
    scheduler.schedule();
    const closing = scheduler.destroy();
    expect(save).toHaveBeenCalledTimes(1);
    await closing;
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('awaits an already-running save before intentional reload', async () => {
    let complete!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const scheduler = createSaveScheduler({ canSave: () => true, save });
    const stop = scheduler.subscribeSuspend();
    scheduler.schedule();
    const first = scheduler.flush();
    let finished = false;
    const reload = flushPendingEditorSaves().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    complete();
    await Promise.all([first, reload]);
    expect(finished).toBe(true);
    stop();
  });
  it('retains a failed save for retry and reports it', async () => {
    const error = new Error('disk full');
    const save = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const scheduler = createSaveScheduler({
      canSave: () => true,
      save,
      onError
    });
    scheduler.schedule();
    await expect(scheduler.flush()).rejects.toThrow('disk full');
    expect(scheduler.pending).toBe(true);
    await scheduler.flush();
    expect(onError).toHaveBeenCalledWith(error);
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('uses configurable delay and cancels a disabled autosave', async () => {
    let enabled = true;
    const save = vi.fn(async () => {});
    const scheduler = createSaveScheduler({
      canSave: () => enabled,
      save,
      delayMs: () => 120
    });
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(save).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    enabled = false;
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
