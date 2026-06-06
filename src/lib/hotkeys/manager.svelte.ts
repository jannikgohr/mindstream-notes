/**
 * Document-level hotkey dispatcher.
 *
 * Lifecycle:
 *   - `initHotkeys()` attaches a single capture-phase keydown listener
 *     on `document`. Called once from `+layout.ts` / root mount.
 *   - Each editor calls `pushActiveEditor()` when it gains focus and
 *     `popActiveEditor()` when it loses focus or unmounts. The manager
 *     keeps a stack so the case "open note B in a split, focus
 *     bounces between A and B" routes correctly.
 *
 * Routing rules (negative-space: invariants the manager refuses to
 * violate, even on weird input):
 *
 *   1. The handler runs in CAPTURE phase so it sees the event before
 *      ProseMirror's own keymap. We only intercept when a binding
 *      matches; everything else bubbles down to Crepe as usual. This
 *      means setting `Mod+B` = "bold" doesn't break the user's ability
 *      to type the letter "b" — only modified events are checked.
 *
 *   2. We DO NOT fire when the keydown target is a non-editor input
 *      (the settings dialog's search field, the FileExplorer's rename
 *      input, …). The active editor's host element is exempted so the
 *      manager still wins inside the contenteditable. Without this
 *      exemption a user hitting Mod+B in the settings search would
 *      toggle Bold in the (unfocused-but-still-on-the-stack) editor.
 *
 *   3. Editor-scoped commands fire ONLY when the active editor's kind
 *      matches the command's `editorKind`. The same id never reaches
 *      the wrong editor — e.g. a markdown command id passed through
 *      to a freeform editor's adapter would no-op and emit a console
 *      warning, but we prevent it from getting there in the first
 *      place.
 *
 *   4. If a binding matches but the corresponding editor isn't
 *      registered (no active editor of that kind), we DO NOT fire and
 *      DO NOT preventDefault — we let the event flow. The alternative
 *      ("swallow the key with no action") would make the app feel
 *      broken when a hotkey "doesn't work" because focus is on a
 *      sidebar element.
 *
 *   5. Global commands fire regardless of focus, but only when the
 *      target check in (2) passes — typing into a search input
 *      shouldn't trigger Mod+, "open settings" mid-search either. The
 *      Mod-modified case is fine because text fields don't normally
 *      consume Mod-letter keys.
 */

import { SvelteSet } from 'svelte/reactivity';
import { formatChord, normalizeKey, parseBinding } from './parse';
import {
  COMMAND_BY_ID,
  HOTKEY_COMMANDS,
  type CommandDefinition,
  type EditorCommand,
  type GlobalCommand
} from './commands';
import { getBinding } from './store.svelte';
import { isMac } from './platform';
import type { Chord, EditorKind } from './types';

/**
 * Adapter an editor exposes to the manager. The editor knows how to
 * map a hotkey command id to its own internal effect — for the
 * markdown editor that's a `crepe.editor.action(...)` call; for the
 * freeform stub it's a no-op until commands are added.
 *
 * `host` is the DOM element that should be considered "the editor" for
 * focus-check purposes (rule 2 above). The manager uses
 * `host.contains(event.target)` to decide whether the editor is
 * eligible to receive a key event regardless of focus state — useful
 * for the case where focus has briefly moved to a toolbar button
 * within the editor's wrapper.
 */
export interface ActiveEditor {
  kind: EditorKind;
  host: HTMLElement;
  /**
   * Run the command identified by `commandId`. The manager only ever
   * calls this with ids whose definition has matching `editorKind`,
   * so the adapter can safely lookup against its own static table
   * without re-validating scope.
   */
  dispatch: (commandId: string) => void;
}

/**
 * Stack of active editors. The TOP of the stack is the editor that
 * gets editor-scoped events. We use a stack (not a single slot)
 * because opening a popout note over an existing one means the
 * underlying NoteEditor is still mounted — we want its register to
 * "yield" to the new top until the new top unregisters, and then
 * automatically restore.
 *
 * Plain array (not SvelteSet) because order matters: the top is the
 * most recently registered editor.
 */
let editorStack: ActiveEditor[] = [];

/**
 * Set of editors that are currently registered, by reference. Used to
 * make `popActiveEditor` idempotent — calling it twice (e.g. once from
 * blur and once from onDestroy) leaves the stack consistent.
 */
const registered = new SvelteSet<ActiveEditor>();

/**
 * Push an editor onto the active stack. Returns the unregister
 * function so the caller can just store the return value and call it
 * from onDestroy without keeping a separate handle.
 */
export function pushActiveEditor(editor: ActiveEditor): () => void {
  if (!registered.has(editor)) {
    registered.add(editor);
    editorStack.push(editor);
  } else {
    // Already on the stack but not at the top — re-promote so a focus
    // bounce between two notes keeps the focused one in charge.
    editorStack = editorStack.filter((e) => e !== editor);
    editorStack.push(editor);
  }
  return () => popActiveEditor(editor);
}

/** Remove an editor from the stack. Idempotent. */
export function popActiveEditor(editor: ActiveEditor): void {
  if (!registered.has(editor)) return;
  registered.delete(editor);
  editorStack = editorStack.filter((e) => e !== editor);
}

/** The current top-of-stack editor, or null if no editor is active. */
function activeEditor(): ActiveEditor | null {
  return editorStack.length > 0 ? editorStack[editorStack.length - 1] : null;
}

/**
 * Direct representation of which DOM-level modifier flags the matcher
 * should check. Computed per-event so the comparison is a flat boolean
 * equality, never a "match if either of these" branch — that's what
 * makes "Cmd+B" and "Ctrl+Cmd+B" reliably distinct.
 */
interface EventFlags {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  keys: string[];
}

/**
 * Extract the modifier flags + key from a KeyboardEvent, or null for
 * events the dispatcher should ignore (IME composition, dead keys,
 * lone modifier presses). `e.key` is layout-AWARE — a German user with
 * QWERTZ hitting the key labelled Z gets `e.key === 'z'`. That
 * property is the source of the user-facing "use current keyboard
 * layout" guarantee.
 */
function keyCandidatesFromEvent(e: KeyboardEvent): string[] {
  const keys: string[] = [];
  const add = (key: string | null) => {
    if (key && !keys.includes(key)) keys.push(key);
  };

  add(normalizeKey(e.key));

  // `KeyboardEvent.key` is layout-aware, which is right for recorded
  // shortcuts, but shifted number-row defaults such as Mod+Shift+8 turn
  // into symbols on many layouts (for example `(` on German keyboards).
  // Keep the typed key first, then add the physical digit as a fallback
  // so catalogue defaults still fire across layouts.
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1] ?? null;
  add(digit);

  return keys;
}

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
 *
 * Equality with `flagsFromEvent` is then strict boolean-for-boolean —
 * no fuzzy "either OR" matching — which is what stops Ctrl+Cmd+B from
 * also firing a plain Mod+B binding on macOS.
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

  // Active editor's host wins regardless of contenteditable: editor
  // commands MUST fire inside their own surface.
  const active = activeEditor();
  if (active && active.host.contains(target)) return false;

  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Find a command whose current binding matches the given event. Returns
 * null if nothing matches — the listener then lets the event flow
 * normally rather than swallowing it with `preventDefault`.
 */
function findMatchingCommand(event: EventFlags): CommandDefinition | null {
  for (const cmd of HOTKEY_COMMANDS) {
    const raw = getBinding(cmd.id);
    if (!raw) continue;
    const parsed = parseBinding(raw);
    if (!parsed) continue;
    if (chordMatchesEvent(parsed, event)) return cmd;
  }
  return null;
}

/** True if the command can fire given the current active-editor state. */
function commandCanFire(cmd: CommandDefinition): boolean {
  if (cmd.scope === 'global') return true;
  const active = activeEditor();
  if (!active) return false;
  return active.kind === cmd.editorKind;
}

function runCommand(cmd: CommandDefinition): void {
  if (cmd.scope === 'global') {
    try {
      (cmd as GlobalCommand).run();
    } catch (err) {
      console.error('[hotkeys] global command threw', cmd.id, err);
    }
    return;
  }
  const active = activeEditor();
  // Defensive: commandCanFire already gated this, but the active
  // editor may have unregistered between the gate and here on a busy
  // event loop. Bail rather than dispatching to nothing.
  if (!active || active.kind !== (cmd as EditorCommand).editorKind) return;
  try {
    active.dispatch(cmd.id);
  } catch (err) {
    console.error('[hotkeys] editor dispatch threw', cmd.id, err);
  }
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

  const onKeyDown = (event: KeyboardEvent) => {
    if (targetIsBlockedInput(event)) return;
    const flags = flagsFromEvent(event);
    if (!flags) return;
    const cmd = findMatchingCommand(flags);
    if (!cmd) return;
    if (!commandCanFire(cmd)) return;
    // Negative-space rule: we only ever call preventDefault on the
    // success path. Anything that doesn't satisfy ALL the conditions
    // above falls through to the browser / editor untouched.
    event.preventDefault();
    event.stopPropagation();
    runCommand(cmd);
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
 * matches via `chordFromEvent` + `chordMatchesEvent` and never
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
    key: flags.keys[0]
  };
  // Round-trip through the parser to reuse the "no unmodified printable
  // key" validation rule — the recorder mustn't store something the
  // matcher would reject.
  const candidate = formatChord(chord);
  const reparsed = parseBinding(candidate);
  if (!reparsed) return null;
  return formatChord(reparsed);
}

// Re-export so callers don't reach into store.svelte directly.
export { COMMAND_BY_ID };
