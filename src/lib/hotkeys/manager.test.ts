/**
 * End-to-end tests for the keydown → bus pipeline.
 *
 * Each test installs a markdown listener on the command bus, fires a
 * synthetic KeyboardEvent through `document`, and asserts the listener
 * receives the right command id. The shifted-number-row case is the
 * regression the remote fix was added for: pressing the key labelled
 * "8" with Shift held produces the SYMBOL `event.key` on a German
 * keyboard layout (`(`), but `event.code` is still `Digit8`. Catalogue
 * defaults like `mod+shift+8` (bullet list) must still fire — the
 * matcher falls back to the digit derived from `event.code` when the
 * typed key doesn't match.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initHotkeys } from './manager.svelte';
import {
  registerEditor,
  unregisterEditor,
  type EditorListener
} from './bus.svelte';

let teardownHotkeys: (() => void) | null = null;
let listener: EditorListener | null = null;

/** Mac vs non-Mac decides whether `mod` resolves to metaKey or ctrlKey.
 *  Tests target the Windows/Linux path because that's where the digit
 *  fallback is most user-visible; pinning navigator.platform makes the
 *  outcome deterministic across CI hosts. */
function forceWindowsModKey() {
  Object.defineProperty(navigator, 'platform', {
    value: 'Win32',
    configurable: true
  });
}

function registerMarkdownListener(
  onCommand: EditorListener['onCommand']
): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  listener = { kind: 'markdown', host, onCommand };
  registerEditor(listener);
}

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init
  });
  document.dispatchEvent(event);
  return event;
}

afterEach(() => {
  if (listener) {
    unregisterEditor(listener);
    listener.host.remove();
    listener = null;
  }
  teardownHotkeys?.();
  teardownHotkeys = null;
});

describe('initHotkeys', () => {
  it('dispatches simple markdown modifier shortcuts', () => {
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true });

    expect(onCommand).toHaveBeenCalledWith('editor.markdown.bold');
    expect(event.defaultPrevented).toBe(true);
  });

  it('matches shifted number-row defaults when the layout emits a symbol', () => {
    // German keyboard, Shift+8 produces "(". The catalogue stores
    // `mod+shift+8` for bullet list; without the event.code fallback
    // this binding would never fire on non-US layouts.
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();

    const event = press({
      key: '(',
      code: 'Digit8',
      ctrlKey: true,
      shiftKey: true
    });

    expect(onCommand).toHaveBeenCalledWith('editor.markdown.bulletList');
    expect(event.defaultPrevented).toBe(true);
  });
});
