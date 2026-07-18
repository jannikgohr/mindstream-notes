import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOAST_DURATION_MS,
  dismissToast,
  pushToast,
  toasts
} from './toast.svelte';

beforeEach(() => {
  toasts.items.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pushToast', () => {
  it('adds a toast with the given message and variant', () => {
    pushToast('Invited alice', { variant: 'success' });
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0]).toMatchObject({
      message: 'Invited alice',
      variant: 'success'
    });
  });

  it('defaults to the info variant', () => {
    pushToast('heads up');
    expect(toasts.items[0].variant).toBe('info');
  });

  it('assigns distinct ids so multiple toasts stack', () => {
    const a = pushToast('one');
    const b = pushToast('two');
    expect(a).not.toBe(b);
    expect(toasts.items.map((t) => t.message)).toEqual(['one', 'two']);
  });

  it('auto-dismisses after the default duration', () => {
    pushToast('bye');
    expect(toasts.items).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(toasts.items).toHaveLength(0);
  });

  it('honours a custom duration', () => {
    pushToast('quick', { durationMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(toasts.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts.items).toHaveLength(0);
  });

  it('never auto-dismisses when duration is 0', () => {
    pushToast('sticky', { durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(toasts.items).toHaveLength(1);
  });
});

describe('dismissToast', () => {
  it('removes the matching toast and leaves the rest', () => {
    const a = pushToast('one', { durationMs: 0 });
    pushToast('two', { durationMs: 0 });
    dismissToast(a);
    expect(toasts.items.map((t) => t.message)).toEqual(['two']);
  });

  it('is a no-op for an unknown id', () => {
    pushToast('one', { durationMs: 0 });
    dismissToast(9999);
    expect(toasts.items).toHaveLength(1);
  });

  it('a manual dismiss before the timer leaves nothing for the timer to do', () => {
    const id = pushToast('one');
    dismissToast(id);
    expect(toasts.items).toHaveLength(0);
    // Timer fires later against an already-gone id — must not throw or wrap.
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(toasts.items).toHaveLength(0);
  });
});
