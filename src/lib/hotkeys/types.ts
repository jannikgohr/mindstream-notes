/**
 * Public hotkey types.
 *
 * A *binding* is the persisted, user-facing representation of a hotkey:
 * a normalized lowercase string like `"mod+shift+b"`, or `null` to mean
 * "no hotkey assigned". `null` is the explicit unset state — the user
 * can clear any binding from the settings menu and the command will
 * simply not be reachable by keyboard until they bind a new one.
 *
 * Internally we work with a parsed `Chord` for matching. We keep both
 * representations because:
 *   - strings round-trip cleanly through JSON/localStorage,
 *   - chords are the right shape to compare against a `KeyboardEvent`
 *     without re-tokenising on every keystroke.
 *
 * Negative-space rule: parsing is the single chokepoint that decides
 * whether a binding is valid. Every other module (manager, settings UI)
 * trusts that any non-null binding it sees has already cleared
 * `parseBinding`'s rules. If you hit invalid input deeper in the stack,
 * the invariant has been broken upstream — fix it there.
 */

/**
 * Identifies the platform-level "command" modifier:
 *   - macOS: ⌘ (event.metaKey)
 *   - everything else: Ctrl (event.ctrlKey)
 *
 * Users author bindings in terms of `mod` so the same string works on
 * both Mac and Windows/Linux without per-platform forks.
 */
export type ModifierToken = 'mod' | 'ctrl' | 'alt' | 'shift';

/**
 * Parsed binding. `key` is normalized — see KEY_ALIASES in parse.ts —
 * and is compared case-insensitively against `KeyboardEvent.key`.
 *
 * Booleans are tri-statable per modifier: `true` = required,
 * `false` = must NOT be pressed. This matters because someone who binds
 * `Mod+B` typically does NOT want `Mod+Shift+B` to also fire — the
 * matcher therefore checks every modifier explicitly, not just the
 * required ones.
 */
export interface Chord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercased key. Empty string is NEVER valid here. */
  key: string;
}

/**
 * Where a command is dispatched.
 *
 *   - `'global'` — runs regardless of focus. Used for "open settings",
 *     "new note", etc. Single-source: there's no contention between
 *     editors.
 *   - `'editor'` — runs only against the currently active editor. The
 *     manager keeps a stack and dispatches to the top. If no editor is
 *     active, the event is left untouched (falls through to the
 *     browser / OS).
 */
export type CommandScope = 'global' | 'editor';

/**
 * Markdown is what's wired up first; the other kinds are reserved so the
 * settings UI can group commands by editor type even before they have
 * any commands of their own.
 */
export type EditorKind = 'markdown' | 'freeform' | 'drawing' | 'ink' | 'pdf';
