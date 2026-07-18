import { afterEach, describe, expect, it } from 'vitest';
import { SPLIT_MIN_WIDTH } from './view-mode';
import { splitAvailable } from './split-available.svelte';

/** Set the emulated viewport width and fire the resize the module listens for. */
function resizeTo(width: number) {
  // happy-dom's innerWidth is a plain settable property.
  (window as unknown as { innerWidth: number }).innerWidth = width;
  window.dispatchEvent(new Event('resize'));
}

describe('splitAvailable', () => {
  const original = window.innerWidth;
  afterEach(() => resizeTo(original));

  it('is true at or above the split threshold', () => {
    resizeTo(SPLIT_MIN_WIDTH);
    expect(splitAvailable()).toBe(true);
    resizeTo(1280);
    expect(splitAvailable()).toBe(true);
  });

  it('is false below the threshold', () => {
    resizeTo(SPLIT_MIN_WIDTH - 1);
    expect(splitAvailable()).toBe(false);
    resizeTo(390); // phone portrait
    expect(splitAvailable()).toBe(false);
  });

  it('tracks a live resize across the threshold', () => {
    resizeTo(1280);
    expect(splitAvailable()).toBe(true);
    resizeTo(500);
    expect(splitAvailable()).toBe(false);
    resizeTo(1024);
    expect(splitAvailable()).toBe(true);
  });
});
