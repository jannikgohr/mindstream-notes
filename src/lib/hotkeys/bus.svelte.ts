/**
 * Command bus.
 *
 * Decouples *who fires a command* from *who knows how to perform it*.
 * The hotkey manager turns a keyboard event into a `CommandDefinition`
 * and hands it to `emitCommand` — that's all it ever does. Editors
 * register an `onCommand(commandId)` listener and react to ids they
 * recognise, without ever touching the hotkey configuration.
 *
 * Two layers of routing:
 *
 *   - **Global commands** are run directly from the command's own
 *     `run()` callback (defined inline in the catalogue). They don't
 *     touch the editor stack — opening Settings should still work
 *     when no note is focused.
 *
 *   - **Editor commands** are dispatched to the top of the editor
 *     stack, but only if the active editor's `kind` matches the
 *     command's `editorKind`. The stack is single-active-at-a-time so
 *     two open notes can't both react to the same Mod+B and mutate
 *     the wrong document.
 *
 * The bus is also the natural entry point for any future
 * non-keyboard caller — a command palette, a Tauri tray menu, a
 * remote-control API — none of which need to know about the hotkey
 * registry. They just `emitCommand(byId('editor.markdown.bold'))`.
 *
 * Negative-space rules:
 *
 *   1. Editor commands NEVER reach an editor of a different kind. A
 *      markdown command id passed to a freeform editor's listener
 *      would no-op there anyway, but the bus's kind check ensures it
 *      doesn't even get there — so a "wrong editor receives the
 *      wrong command" class of bug can't exist.
 *
 *   2. `emitCommand` returns `false` when nothing handled the
 *      command. The manager treats that as "don't `preventDefault`
 *      either" — an unhandled hotkey behaves the same as no hotkey
 *      at all, falling through to whatever the editor / browser
 *      would have done.
 *
 *   3. `unregisterEditor` is idempotent. The same registration can
 *      be unregistered from focusout and onDestroy without leaving
 *      the stack in a half-removed state.
 */

import { SvelteSet } from 'svelte/reactivity';
import type {
  CommandDefinition,
  EditorCommand,
  GlobalCommand
} from './commands';
import type { EditorKind } from './types';

/**
 * Listener contract editors expose to the bus.
 *
 * `onCommand` returns `true` when it handled the command, `false`
 * (or `void`, treated as handled) otherwise. Returning explicit
 * `false` is what tells the bus "this id doesn't apply here, don't
 * pretend you ran something" — useful for the stub freeform editor
 * which doesn't recognise any commands yet but is still on the stack.
 *
 * `host` is the DOM element that should count as "the editor" for
 * focus-check purposes. The hotkey manager uses it to allow events
 * fired from inside a contenteditable to reach editor-scoped commands
 * — without that exemption every keypress inside a note would be
 * filtered out by the blocked-input rule.
 */
export interface EditorListener {
  kind: EditorKind;
  host: HTMLElement;
  onCommand: (commandId: string) => boolean | void;
}

/** Stack of registered editor listeners. TOP = most recently focused;
 *  the bus dispatches editor commands here. We use a stack instead of a
 *  single slot so two open notes (dockview split, popout window) can
 *  both keep their listeners installed, with focus deciding who's on
 *  top. */
let editorStack: EditorListener[] = [];

/** Set of currently-registered listeners (by reference). Backs the
 *  idempotency of `unregisterEditor` and tells `registerEditor` whether
 *  a call is "register fresh" vs "re-promote on focusin". */
const registered = new SvelteSet<EditorListener>();

/**
 * Add an editor listener to the stack, or re-promote an existing one
 * to the top. Returns the unregister function so the caller can stash
 * the return value and call it from `onDestroy` without keeping a
 * separate handle.
 *
 * Re-promotion on re-register is what makes focus tracking work: when
 * the user clicks back into note A after focusing note B, A's
 * `focusin` handler calls `registerEditor` again and A jumps to the
 * top of the stack. The first call from `onMount` and the subsequent
 * calls from `focusin` share the same code path.
 */
export function registerEditor(listener: EditorListener): () => void {
  if (registered.has(listener)) {
    editorStack = editorStack.filter((e) => e !== listener);
  } else {
    registered.add(listener);
  }
  editorStack.push(listener);
  return () => unregisterEditor(listener);
}

/** Remove an editor listener from the stack. Idempotent — calling
 *  twice (e.g. once from blur, once from onDestroy) leaves the stack
 *  consistent. */
export function unregisterEditor(listener: EditorListener): void {
  if (!registered.has(listener)) return;
  registered.delete(listener);
  editorStack = editorStack.filter((e) => e !== listener);
}

/** The current top-of-stack editor, or `null` if none registered.
 *  Used by the hotkey manager to decide whether an editor-scoped
 *  command can fire, AND to exempt the editor's host from the
 *  blocked-input check on keydown. */
export function activeEditor(): EditorListener | null {
  return editorStack.length > 0 ? editorStack[editorStack.length - 1] : null;
}

/**
 * Run a command.
 *
 * For `global` commands: invoke the catalogue's inline `run()`.
 *
 * For `editor` commands: hand the command id to the top-of-stack
 * editor IF its `kind` matches; otherwise no-op. Returns `true` when
 * a listener actually handled the command (so the manager knows to
 * `preventDefault` the keystroke), `false` when not.
 *
 * Exceptions from the listener / runner are caught and logged so a
 * bug in one command can't permanently break the bus.
 */
export function emitCommand(cmd: CommandDefinition): boolean {
  if (cmd.scope === 'global') {
    try {
      (cmd as GlobalCommand).run();
      return true;
    } catch (err) {
      console.error('[hotkeys] global command threw', cmd.id, err);
      return false;
    }
  }
  const active = activeEditor();
  if (!active || active.kind !== (cmd as EditorCommand).editorKind) {
    return false;
  }
  try {
    const handled = active.onCommand(cmd.id);
    // Default to "handled" if the listener returns void — most
    // listeners just do the work and don't bother returning anything.
    return handled !== false;
  } catch (err) {
    console.error('[hotkeys] editor listener threw', cmd.id, err);
    return false;
  }
}
