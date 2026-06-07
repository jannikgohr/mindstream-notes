/**
 * Document-level hotkey dispatcher.
 *
 * Single responsibility: turn a `KeyboardEvent` into a `CommandDefinition`
 * and hand it to the command bus. Everything else — editor stack,
 * command execution, error handling — lives in `bus.svelte.ts`. This
 * file is intentionally thin so the bus can be driven from non-keyboard
 * sources (command palette, tray menu, …) without going through any of
 * the platform / chord parsing here.
 *
 * Routing rules (negative-space: invariants the manager refuses to
 * violate, even on weird input):
 *
 *   1. The handler runs in CAPTURE phase so it sees the event before
 *      ProseMirror's own keymap. We only intercept when a binding
 *      matches AND a listener handles it; everything else bubbles down
 *      to Crepe as usual. This means setting `Mod+B` = "bold" doesn't
 *      break the user's ability to type the letter "b" — only modified
 *      events are even checked.
 *
 *   2. We DO NOT fire when the keydown target is a non-editor input
 *      (the settings dialog's search field, the FileExplorer's rename
 *      input, …). The active editor's host element is exempted so the
 *      manager still wins inside the contenteditable.
 *
 *   3. Editor-scoped commands fire ONLY when the bus's active editor's
 *      kind matches. The bus enforces this; the manager just calls
 *      `emitCommand`.
 *
 *   4. If `emitCommand` returns `false` (no listener handled the
 *      command — typically because no editor of the right kind is
 *      active), we DO NOT `preventDefault`. The keystroke flows through
 *      to the browser / editor untouched.
 */

import { formatChord, normalizeKey, parseBinding } from './parse';
import { HOTKEY_COMMANDS, type CommandDefinition } from './commands';
import {
  getBinding,
  hotkeys,
  hydrateBindingsFromSettings
} from './store.svelte';
import { activeEditor, emitCommand } from './bus.svelte';
import { isMac } from './platform';
import type { Chord } from './types';

/**
 * Direct representation of which DOM-level modifier flags the matcher
 * should check. Computed per-event so the comparison is a flat boolean
 * equality, never a "match if either of these" branch — that's what
 * makes "Cmd+B" and "Ctrl+Cmd+B" reliably distinct.
 *
 * `keys` carries every plausible normalised token the event could
 * stand for: the typed `event.key` first (layout-aware, the canonical
 * surface for user-recorded shortcuts), then a physical-digit
 * fallback derived from `event.code` so number-row defaults like
 * `mod+shift+8` (bullet list) still fire on layouts where Shift+8
 * produces a symbol — `(` on US, `(` on German, `*` on FR, etc. The
 * matcher checks `binding.key` against this list, so a chord
 * matching ANY candidate fires.
 */
interface EventFlags {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  keys: string[];
}

/**
 * Build the candidate-key list for an event. Order is significant:
 *
 *   1. `event.key` (layout-aware): always tried first because it's what
 *      the user actually typed and what the recorder stored when they
 *      saved a custom binding.
 *   2. digit derived from `event.code` for `DigitN` / `NumpadN`:
 *      handled separately so shifted number-row defaults still match
 *      when the OS layout maps Shift+8 to "(" or "*". Without this
 *      fallback, ⌘⇧8 only fires on US-style layouts.
 *
 * We deliberately do NOT use `event.code` for letters — the user asked
 * for shortcuts to follow the current keyboard layout (German users
 * recording the key labelled Z get "z"), and KeyZ would override that.
 * The digit fallback is the one case where physical position is the
 * stable identifier the user actually means.
 */
function keyCandidatesFromEvent(e: KeyboardEvent): string[] {
  const keys: string[] = [];
  const add = (key: string | null) => {
    if (key && !keys.includes(key)) keys.push(key);
  };

  add(normalizeKey(e.key));

  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1] ?? null;
  add(digit);

  return keys;
}

/**
 * Extract modifier flags + candidate keys from a KeyboardEvent, or
 * null for events the dispatcher should ignore (IME composition,
 * dead keys, lone modifier presses).
 *
 * `event.key` is layout-AWARE — a German user with QWERTZ hitting the
 * key labelled Z gets `event.key === 'z'`. That property is the source
 * of the user-facing "use current keyboard layout" guarantee.
 */
function flagsFromEvent(e: KeyboardEvent): EventFlags | null {
  if (e.isComposing) return null;
  if (e.key === 'Dead' || e.key === 'Unidentified') return null;
  if (
    e.key === 'Shift' ||
    e.key === 'Control' ||
    e.key === 'Alt' ||
    e.key === 'Meta' ||
    e.key === 'OS'
  ) {
    return null;
  }
  const keys = keyCandidatesFromEvent(e);
  if (keys.length === 0) return null;
  return {
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    keys
  };
}

/**
 * Resolve a binding chord into the exact DOM modifier flags it expects
 * on the *current* platform. This is what makes `mod` platform-aware
 * without spreading the platform check across the rest of the file.
 *
 *   - Mac: `mod` → metaKey; `ctrl` stays as ctrlKey. The two are
 *     independently bindable (e.g. ⌘B vs ⌃B).
 *   - everywhere else: `mod` IS Ctrl. We collapse `mod || ctrl` into a
 *     single ctrlKey requirement so users can't accidentally bind
 *     two-distinct-modifier shortcuts that the OS can't produce.
 */
function bindingFlags(binding: Chord): {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
} {
  if (isMac()) {
    return {
      meta: binding.mod,
      ctrl: binding.ctrl,
      alt: binding.alt,
      shift: binding.shift
    };
  }
  return {
    meta: false,
    ctrl: binding.mod || binding.ctrl,
    alt: binding.alt,
    shift: binding.shift
  };
}

/**
 * True when the binding matches the event exactly: every modifier flag
 * either required-and-pressed or not-required-and-not-pressed, plus
 * key equality. Strict on purpose so `mod+b` and `mod+shift+b` can be
 * bound to different commands without one shadowing the other.
 */
function chordMatchesEvent(binding: Chord, event: EventFlags): boolean {
  const want = bindingFlags(binding);
  if (event.meta !== want.meta) return false;
  if (event.ctrl !== want.ctrl) return false;
  if (event.alt !== want.alt) return false;
  if (event.shift !== want.shift) return false;
  // Match against the candidate list, not a single key: the typed
  // `event.key` AND a digit fallback derived from `event.code` are
  // both acceptable. A binding fires as soon as any candidate hits.
  if (!event.keys.includes(binding.key)) return false;
  return true;
}

/**
 * Should we even look at this event? Skips when the keydown target is
 * an editable element that isn't part of the currently active editor's
 * host. The active editor's contenteditable IS allowed because that's
 * where editor commands need to fire.
 */
function targetIsBlockedInput(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;

  const active = activeEditor();
  if (active && active.host.contains(target)) return false;

  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function targetIsHotkeyRecorder(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('[data-hotkey-recorder="true"]'));
}

/**
 * Crepe's ProseMirror keymap binds a handful of chords to its built-in
 * commands at editor construction. These are baked in and we can't
 * uninstall them from outside, so a user who unsets `Mod+B` in our
 * settings would *still* see Crepe toggle bold when they press it —
 * because Crepe's keymap fires independently of ours.
 *
 * Fix: when a chord lands that matches a Crepe-native binding AND our
 * binding for the same command has been changed or unset, we
 * `preventDefault` to swallow the event without running anything. Our
 * normal "the binding matches, fire and preventDefault" path still
 * wins when the user hasn't changed the default — same chord, same
 * outcome, just routed through our path with our error handling.
 *
 * Whitelist is small on purpose: every entry here is a chord that
 * Crepe is *known* to bind (verified against the @milkdown/preset-
 * commonmark and @milkdown/plugin-history keymaps). Adding a chord
 * that Crepe DOESN'T bind would be a false positive — the user
 * presses it expecting their default-typing behaviour (e.g. a
 * shifted symbol) and we silently swallow it. False negatives
 * (a chord we don't list that Crepe DOES bind) only mean
 * "unsetting it doesn't actually disable it" — annoying but
 * recoverable. We err on the side of the negative.
 */
const CREPE_NATIVE_CHORDS: Record<string, string> = {
  'mod+b': 'editor.markdown.bold',
  'mod+i': 'editor.markdown.italic',
  'mod+z': 'editor.markdown.undo',
  'mod+shift+z': 'editor.markdown.redo'
};

/**
 * True when the event matches a Crepe-native chord whose command our
 * user has remapped or unset. Caller responds by calling
 * `preventDefault` without dispatching anything — that's enough to
 * stop Crepe's ProseMirror keymap from acting.
 *
 * Only kicks in when a markdown editor is active. On any other surface
 * Crepe's keymap isn't installed, so suppression would be both
 * unnecessary and a UX bug (the user might want the character to type
 * normally).
 */
function shouldSuppressCrepeNative(event: EventFlags): boolean {
  const active = activeEditor();
  if (!active || active.kind !== 'markdown') return false;
  for (const [chord, commandId] of Object.entries(CREPE_NATIVE_CHORDS)) {
    const parsed = parseBinding(chord);
    if (!parsed) continue;
    if (!chordMatchesEvent(parsed, event)) continue;
    // The event is the Crepe-native chord. If our binding for the
    // same command STILL points at this chord, the normal match path
    // already fired our command (and called preventDefault). We
    // wouldn't be here — `findMatchingCommand` would have returned
    // the command. So reaching this point means the binding has
    // diverged, and we suppress.
    const current = getBinding(commandId);
    return current !== chord;
  }
  return false;
}

/**
 * Find a command whose current binding matches the given event.
 *
 * Two-pass with a priority rule:
 *
 *   1. User-customised bindings (entries in `hotkeys.bindings`) win
 *      immediately — return on first match.
 *   2. Catalogue-default matches are kept aside and only returned if
 *      no user-customised binding matched.
 *
 * Why: without this, remapping italic to `mod+b` while leaving bold
 * alone leaves both commands claiming `mod+b` (italic via override,
 * bold via default). Catalogue iteration order would pick bold and
 * italic would silently never fire.
 *
 * Reads go through `getBinding` so default-only commands still work
 * before `hydrateBindingsFromSettings` runs, AND so reactivity tracks
 * — a binding the user just changed in the settings panel is
 * effective on the very next keypress.
 */
function findMatchingCommand(event: EventFlags): CommandDefinition | null {
  const active = activeEditor();
  let defaultMatch: CommandDefinition | null = null;
  for (const cmd of HOTKEY_COMMANDS) {
    if (cmd.scope === 'editor' && active?.kind !== cmd.editorKind) continue;
    const raw = getBinding(cmd.id);
    if (!raw) continue;
    const parsed = parseBinding(raw);
    if (!parsed) continue;
    if (!chordMatchesEvent(parsed, event)) continue;
    if (cmd.id in hotkeys.bindings) return cmd;
    defaultMatch ??= cmd;
  }
  return defaultMatch;
}

let installed = false;
let removeListener: (() => void) | null = null;

/**
 * Attach the capture-phase document keydown listener. Idempotent —
 * safe to call from each route or component without worrying about
 * doubling up. Returns a teardown function in case a host wants to
 * detach the manager (mostly useful in tests).
 */
export function initHotkeys(): () => void {
  if (installed) return removeListener ?? (() => {});
  if (typeof document === 'undefined') return () => {};

  // Pull user-saved bindings into the reactive map. Deferred to here
  // (rather than the store's module-init) so we're past any
  // import-cycle weirdness between this module and the settings
  // store — by the time the layout calls `initHotkeys()` everything
  // is loaded.
  hydrateBindingsFromSettings();

  const onKeyDown = (event: KeyboardEvent) => {
    if (targetIsHotkeyRecorder(event)) {
      return;
    }
    if (targetIsBlockedInput(event)) {
      return;
    }
    const flags = flagsFromEvent(event);
    if (!flags) {
      return;
    }
    const cmd = findMatchingCommand(flags);
    if (cmd) {
      // Emit first, then preventDefault only if the bus actually
      // handled it. An editor-scoped binding fired with no matching
      // editor active should fall through to the editor / browser
      // exactly as it would have if no binding existed at all.
      const handled = emitCommand(cmd);
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // No matching binding — but if the event would have activated one
    // of Crepe's built-in shortcuts for a command our user has
    // remapped or unset, suppress it. Otherwise the editor's keymap
    // would keep firing the OLD chord forever after a rebind, which
    // is what "unset" is supposed to fix.
    if (shouldSuppressCrepeNative(flags)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  };

  document.addEventListener('keydown', onKeyDown, { capture: true });
  installed = true;
  removeListener = () => {
    document.removeEventListener('keydown', onKeyDown, { capture: true });
    installed = false;
    removeListener = null;
  };
  return removeListener;
}

// --- Recorder helpers ------------------------------------------------------

/**
 * Convert a single KeyboardEvent into a canonical binding string,
 * suitable for showing-and-saving from the settings recorder.
 * Returns `null` if the event doesn't produce a bindable chord
 * (modifier-only press, IME composition, dead key, …).
 *
 * The settings UI is the only legitimate consumer; the manager itself
 * matches via `flagsFromEvent` + `chordMatchesEvent` and never
 * stringifies the live event.
 */
export function bindingFromEvent(event: KeyboardEvent): string | null {
  const flags = flagsFromEvent(event);
  if (!flags) return null;
  // Translate raw modifier flags back into a binding chord. On non-mac
  // platforms ctrlKey is the platform mod, so we emit `mod` rather than
  // `ctrl` to preserve cross-platform portability — a user who records
  // Ctrl+B on Windows should still hit Cmd+B on a Mac sync target.
  const mac = isMac();
  const chord: Chord = {
    mod: mac ? flags.meta : flags.ctrl,
    ctrl: mac ? flags.ctrl : false,
    alt: flags.alt,
    shift: flags.shift,
    // Use the *typed* key (first candidate) when storing a recorded
    // binding. The digit-fallback candidate is intentionally NOT
    // persisted — the recorder respects whatever the user actually
    // typed, so a French user recording Mod+Shift+8 saves `mod+shift+8`
    // and that string still resolves correctly later because the
    // matcher applies the same fallback at dispatch time.
    key: flags.keys[0]
  };
  // Round-trip through formatChord + parseBinding to reuse the
  // "no unmodified printable key" validation rule — the recorder must
  // not store something the matcher would reject.
  const candidate = formatChord(chord);
  const reparsed = parseBinding(candidate);
  if (!reparsed) return null;
  return formatChord(reparsed);
}
