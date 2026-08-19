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
import { bindingFromEvent, initHotkeys } from './manager.svelte';
import {
  registerEditor,
  unregisterEditor,
  APP_REDO_COMMAND,
  APP_UNDO_COMMAND,
  type EditorListener
} from './bus.svelte';
import { hotkeys } from './store.svelte';
import type { EditorKind } from './types';
import { setActiveNote } from '$lib/state.svelte';

let teardownHotkeys: (() => void) | null = null;
let listeners: EditorListener[] = [];

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
  onCommand: EditorListener['onCommand'],
  noteId?: string
): HTMLElement {
  return registerEditorListener('markdown', onCommand, noteId);
}

function registerEditorListener(
  kind: EditorKind,
  onCommand: EditorListener['onCommand'],
  noteId?: string
): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const listener: EditorListener = { kind, host, noteId, onCommand };
  listeners.push(listener);
  registerEditor(listener);
  return host;
}

/** A keydown event that is inspected rather than dispatched. */
function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init
  });
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
  for (const listener of listeners) {
    unregisterEditor(listener);
    listener.host.remove();
  }
  listeners = [];
  teardownHotkeys?.();
  teardownHotkeys = null;
  setActiveNote(null);
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

  it('dispatches shared app undo/redo shortcuts to the active editor', () => {
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand, 'note-md');
    setActiveNote('note-md');
    teardownHotkeys = initHotkeys();

    const undoEvent = press({ key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(onCommand).toHaveBeenCalledWith(APP_UNDO_COMMAND);
    expect(undoEvent.defaultPrevented).toBe(true);

    onCommand.mockClear();
    const redoEvent = press({
      key: 'z',
      code: 'KeyZ',
      ctrlKey: true,
      shiftKey: true
    });
    expect(onCommand).toHaveBeenCalledWith(APP_REDO_COMMAND);
    expect(redoEvent.defaultPrevented).toBe(true);
  });

  it('dispatches shared app undo/redo shortcuts only to the active note editor', () => {
    forceWindowsModKey();
    const pdfCommand = vi.fn(() => true);
    registerEditorListener('pdf', pdfCommand, 'note-pdf');
    const staleMarkdownCommand = vi.fn(() => true);
    registerMarkdownListener(staleMarkdownCommand, 'note-md');
    setActiveNote('note-pdf');
    teardownHotkeys = initHotkeys();

    const event = press({ key: 'z', code: 'KeyZ', ctrlKey: true });

    expect(pdfCommand).toHaveBeenCalledWith(APP_UNDO_COMMAND);
    expect(staleMarkdownCommand).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not dispatch shared app undo/redo shortcuts when no note is active', () => {
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand, 'note-md');
    setActiveNote(null);
    teardownHotkeys = initHotkeys();

    const event = press({ key: 'z', code: 'KeyZ', ctrlKey: true });

    expect(onCommand).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
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
    const listener: EditorListener = {
      kind: 'freeform',
      host,
      onCommand: () => true
    };
    listeners.push(listener);
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
    // Undo remapped to mod+j. Press mod+z: no command fires
    // (undo is now on mod+j), but the manager preventDefaults so
    // Crepe's built-in undo doesn't run either. The point of
    // "remap" is that the old chord truly no longer does the old
    // thing.
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['global.undo'] = 'mod+j';

    const event = press({ key: 'z', code: 'KeyZ', ctrlKey: true });

    expect(onCommand).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('suppresses a Crepe-native chord whose command has been unset', () => {
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();
    hotkeys.bindings['global.undo'] = null;

    const event = press({ key: 'z', code: 'KeyZ', ctrlKey: true });

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
    const listener: EditorListener = {
      kind: 'freeform',
      host,
      onCommand: () => true
    };
    listeners.push(listener);
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

/** Pin the mac path, where `mod` resolves to metaKey rather than ctrlKey. */
function forceMacModKey() {
  Object.defineProperty(navigator, 'platform', {
    value: 'MacIntel',
    configurable: true
  });
}

describe('initHotkeys — events that are not chords', () => {
  it('ignores a modifier pressed on its own', () => {
    // Holding Ctrl before the real key must not dispatch anything.
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();

    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'OS']) {
      press({ key, ctrlKey: true });
    }

    expect(onCommand).not.toHaveBeenCalled();
  });

  it('leaves keystrokes inside a hotkey recorder alone', () => {
    // Otherwise recording a binding would fire the command it is replacing.
    forceWindowsModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();

    const recorder = document.createElement('button');
    recorder.dataset.hotkeyRecorder = 'true';
    document.body.appendChild(recorder);

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true }, recorder);

    expect(onCommand).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    recorder.remove();
  });
});

describe('initHotkeys — the browser find chord', () => {
  it('suppresses Ctrl+F even with nothing bound to it', () => {
    // The webview's native find is useless against a virtualized PDF canvas
    // and a contenteditable editor, so it must never open.
    forceWindowsModKey();
    teardownHotkeys = initHotkeys();

    expect(press({ key: 'f', code: 'KeyF', ctrlKey: true }).defaultPrevented) //
      .toBe(true);
  });

  it('suppresses Cmd+F on a Mac, and leaves Ctrl+F alone there', () => {
    forceMacModKey();
    teardownHotkeys = initHotkeys();

    expect(press({ key: 'f', code: 'KeyF', metaKey: true }).defaultPrevented) //
      .toBe(true);
    expect(press({ key: 'f', code: 'KeyF', ctrlKey: true }).defaultPrevented) //
      .toBe(false);
  });

  it('leaves the chord alone once another modifier joins it', () => {
    forceWindowsModKey();
    teardownHotkeys = initHotkeys();

    expect(
      press({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })
        .defaultPrevented
    ).toBe(false);
    // Plain "f" is a character the user is typing.
    expect(press({ key: 'f', code: 'KeyF' }).defaultPrevented).toBe(false);
  });
});

describe('initHotkeys — the mac modifier mapping', () => {
  it('resolves mod to the command key', () => {
    forceMacModKey();
    const onCommand = vi.fn(() => true);
    registerMarkdownListener(onCommand);
    teardownHotkeys = initHotkeys();

    press({ key: 'b', code: 'KeyB', metaKey: true });
    expect(onCommand).toHaveBeenCalledWith('editor.markdown.bold');

    // Ctrl is a separate modifier there, not the platform mod.
    onCommand.mockClear();
    press({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('bindingFromEvent', () => {
  it('records a chord as the portable "mod" form', () => {
    // A user who records Ctrl+B on Windows should still hit Cmd+B after
    // syncing to a Mac, so the platform modifier is stored as `mod`.
    forceWindowsModKey();
    expect(
      bindingFromEvent(keyEvent({ key: 'b', code: 'KeyB', ctrlKey: true }))
    ).toBe('mod+b');

    forceMacModKey();
    expect(
      bindingFromEvent(keyEvent({ key: 'b', code: 'KeyB', metaKey: true }))
    ).toBe('mod+b');
  });

  it('keeps a real ctrl press distinct from mod on a Mac', () => {
    forceMacModKey();
    expect(
      bindingFromEvent(
        keyEvent({ key: 'b', code: 'KeyB', metaKey: true, ctrlKey: true })
      )
    ).toBe('mod+ctrl+b');
  });

  it('records the key the user actually typed', () => {
    // On a German layout Mod+Shift+8 arrives as "(", and that is what gets
    // stored — the matcher applies the digit fallback again at dispatch.
    forceWindowsModKey();
    expect(
      bindingFromEvent(
        keyEvent({ key: '(', code: 'Digit8', ctrlKey: true, shiftKey: true })
      )
    ).toBe('mod+shift+(');
  });

  it('refuses a modifier-only press', () => {
    forceWindowsModKey();
    expect(bindingFromEvent(keyEvent({ key: 'Control', ctrlKey: true }))).toBe(
      null
    );
  });

  it('refuses an unmodified printable key, which the matcher would reject', () => {
    forceWindowsModKey();
    expect(bindingFromEvent(keyEvent({ key: 'b', code: 'KeyB' }))).toBe(null);
  });

  it('accepts an unmodified function key', () => {
    forceWindowsModKey();
    expect(bindingFromEvent(keyEvent({ key: 'F2', code: 'F2' }))).toBe('f2');
  });
});
