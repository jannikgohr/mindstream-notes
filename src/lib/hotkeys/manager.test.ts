/**
 * End-to-end tests for the keydown → bus pipeline.
 *
 * Each test installs an editor listener, fires a synthetic
 * KeyboardEvent through the document (or a specific element), and
 * asserts the listener saw the right command id and the event's
 * `defaultPrevented` flag matches the expected interception result.
 *
 * The shifted-number-row case is the regression the remote fix was
 * added for: pressing the key labelled "8" with Shift held produces
 * the symbol `event.key` on a German keyboard layout (`(`), but
 * `event.code` is still `Digit8`. Catalogue defaults like
 * `mod+shift+8` (bullet list) must still fire — the matcher falls
 * back to the digit derived from `event.code` when the typed key
 * doesn't match.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initHotkeys } from './manager.svelte';
import {
  registerEditor,
  unregisterEditor,
  type EditorListener
} from './bus.svelte';
import { hotkeys } from './store.svelte';
import type { EditorKind } from './types';

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
): HTMLElement {
  return registerEditorListener('markdown', onCommand);
}

function registerEditorListener(
  kind: EditorKind,
  onCommand: EditorListener['onCommand']
): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  listener = { kind, host, onCommand };
  registerEditor(listener);
  return host;
}

function press(init: KeyboardEventInit, target?: EventTarget) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init
  });
  (target ?? document).dispatchEvent(event);
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
  // Wipe any binding overrides so default-driven tests aren't
  // contaminated by a previous test's setup.
  for (const key of Object.keys(hotkeys.bindings)) {
    delete hotkeys.bindings[key];
  }
});

describe('initHotkeys — match and dispatch', () => {
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

  it('user-customised binding wins over a default match on the same chord', () => {
    // Regression for the matcher's two-pass priority. If italic is
    // remapped to mod+b (a non-default chord for it), bold's default
    // ALSO claims mod+b. Without priority the catalogue-order tie
    // breaker picks bold and italic silently never fires.
    //
    // `initHotkeys` runs hydrate which wipes non-persisted in-memory
    // overrides, so the mutation MUST happen after init for the test
    // to model an in-session change (recorder → setBinding →
    // hotkeys.bindings updated).
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['editor.markdown.italic'] = 'mod+b';

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true });

    expect(onCommand).toHaveBeenCalledWith('editor.markdown.italic');
    expect(event.defaultPrevented).toBe(true);
  });

  it('routes shared editor chords to the active note type', () => {
    // Markdown and ink are allowed to share a binding because only
    // one editor kind can be active. The manager must therefore skip
    // matching commands for inactive editor kinds instead of stopping
    // at the first catalogue match.
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerEditorListener('ink', onCommand);
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['editor.markdown.bold'] = 'mod+x';
    hotkeys.bindings['editor.ink.pen'] = 'mod+x';

    const event = press({ key: 'x', code: 'KeyX', ctrlKey: true });

    expect(onCommand).toHaveBeenCalledWith('editor.ink.pen');
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not dispatch global-shortcut-only commands inside the webview', () => {
    forceWindowsModKey();
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['global.showApp'] = 'mod+x';

    const event = press({ key: 'x', code: 'KeyX', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('initHotkeys — fall-through cases', () => {
  it('does not preventDefault when no listener handles the command', () => {
    // Editor returns `false` (declines). Bus reports unhandled; the
    // manager must let the event flow. Otherwise an editor that
    // hasn't implemented a command would still consume the
    // keystroke, leaving the user unable to type the character.
    forceWindowsModKey();
    const onCommand = vi.fn(() => false);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true });

    expect(onCommand).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not fire when target is an INPUT outside the editor host', () => {
    // Settings dialog search field, FileExplorer rename input, etc.
    // The editor IS active, but the keystroke is going somewhere
    // else; the manager must NOT route it.
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();

    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true }, input);

    expect(onCommand).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    input.remove();
  });

  it('does not fire when no editor of the right kind is active', () => {
    // Manager finds a matching command (markdown default), but
    // there's no active markdown editor — only a freeform one. Bus
    // returns unhandled; nothing fires, nothing prevented.
    forceWindowsModKey();
    const host = document.createElement('div');
    document.body.appendChild(host);
    listener = { kind: 'freeform', host, onCommand: () => true };
    registerEditor(listener);
    teardownHotkeys = initHotkeys();

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('initHotkeys — unset and Crepe-native suppression', () => {
  it('does not fire when a non-Crepe-native binding is unset', () => {
    // Bullet list default is mod+shift+8. After unset, pressing
    // mod+shift+8 must not fire AND must not preventDefault — there
    // is no built-in editor shortcut to suppress.
    //
    // Note the init-then-mutate ordering: initHotkeys calls hydrate,
    // which deletes hotkeys.bindings entries not backed by
    // settings.values. Mutating before init would get wiped.
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['editor.markdown.bulletList'] = null;

    const event = press({
      key: '(',
      code: 'Digit8',
      ctrlKey: true,
      shiftKey: true
    });

    expect(onCommand).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('suppresses a Crepe-native chord whose command has been remapped', () => {
    // Bold remapped to mod+j. Press mod+b: no command fires (bold
    // is now on mod+j), but the manager preventDefaults so Crepe's
    // built-in mod+b → toggleStrong doesn't run either. The point
    // of "remap" is that the old chord truly no longer does the
    // old thing.
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['editor.markdown.bold'] = 'mod+j';

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true });

    expect(onCommand).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('suppresses a Crepe-native chord whose command has been unset', () => {
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['editor.markdown.bold'] = null;

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true });

    expect(onCommand).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('does NOT suppress Crepe natives when no markdown editor is active', () => {
    // The whole point of suppression is to override Crepe's keymap,
    // which only exists inside a markdown editor. If the user is on
    // a freeform canvas (or no editor at all), Mod+B should type
    // normally — not be silently swallowed.
    forceWindowsModKey();
    const host = document.createElement('div');
    document.body.appendChild(host);
    listener = { kind: 'freeform', host, onCommand: () => true };
    registerEditor(listener);
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['editor.markdown.bold'] = 'mod+j';

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('initHotkeys — browser find suppression', () => {
  it('suppresses Mod+F even when no editor handles find', () => {
    // The webview's native find is useless here, so the chord must be
    // swallowed regardless of whether anything opens. No editor is
    // registered, so search-active-note reports unhandled — yet the
    // browser find must still not appear.
    forceWindowsModKey();
    teardownHotkeys = initHotkeys();

    const event = press({ key: 'f', code: 'KeyF', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
  });

  it('suppresses Mod+F even when the binding is unset', () => {
    forceWindowsModKey();
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['global.searchActiveNote'] = null;

    const event = press({ key: 'f', code: 'KeyF', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves other F chords (e.g. Ctrl+Alt+F) alone', () => {
    forceWindowsModKey();
    teardownHotkeys = initHotkeys();

    const event = press({
      key: 'f',
      code: 'KeyF',
      ctrlKey: true,
      altKey: true
    });

    expect(event.defaultPrevented).toBe(false);
  });
});
