import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts } from '$lib/components/toast.svelte';
import { freezeCloseInput } from './close-overlay';

vi.mock('$lib/settings/i18n.svelte', () => ({ tUi: (key: string) => key }));
let restore: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main></main><div data-toast-region></div>';
  toasts.items.length = 0;
});
afterEach(() => {
  restore?.();
  restore = undefined;
  toasts.items.length = 0;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('close progress toast', () => {
  it('keeps one progress toast until native cancellation and restores input', () => {
    const operation = freezeCloseInput();
    restore = operation.restore;
    expect(document.querySelector('main')!.inert).toBe(true);
    expect(
      (document.querySelector('[data-toast-region]') as HTMLElement).inert
    ).toBe(false);
    vi.advanceTimersByTime(200);
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0]).toMatchObject({
      variant: 'progress',
      dismissible: false
    });
    const id = toasts.items[0].id;
    operation.phase('prepare');
    vi.advanceTimersByTime(60_000);
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0]).toMatchObject({
      id,
      message: 'vault.savingChanges'
    });
    expect(document.querySelector('dialog')).toBeNull();
    operation.restore();
    expect(toasts.items).toHaveLength(0);
    expect(document.querySelector('main')!.inert).toBe(false);
  });

  it('cancels a short operation without a late toast and restores prior inertness', () => {
    const main = document.querySelector('main')!;
    main.inert = true;
    const operation = freezeCloseInput();
    restore = operation.restore;
    const blocked = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true
    });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    operation.restore();
    vi.advanceTimersByTime(1000);
    expect(toasts.items).toHaveLength(0);
    expect(main.inert).toBe(true);
    const resumed = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true
    });
    window.dispatchEvent(resumed);
    expect(resumed.defaultPrevented).toBe(false);
  });
});
