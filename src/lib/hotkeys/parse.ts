/**
 * Binding string ⇄ Chord conversion.
 *
 * Authoring format is a `+`-joined list of tokens, case-insensitive:
 *
 *     "mod+shift+b"       → ⌘⇧B on mac, Ctrl+Shift+B elsewhere
 *     "mod+alt+1"         → ⌘⌥1 on mac, Ctrl+Alt+1 elsewhere
 *     "ctrl+enter"        → literal Ctrl on every platform
 *     "f1"                → unmodified function key (legal — see below)
 *
 * Why a custom mini-format and not a DOM-level descriptor (e.g. the
 * native `KeyboardEvent.code` or VS Code's `keybinding-resolver`
 * format): the user asked for shortcuts that follow the *current
 * keyboard layout* rather than the physical key position. `event.code`
 * is layout-INdependent (KeyZ stays KeyZ on QWERTZ even though the user
 * sees Z where Y is). `event.key` IS layout-dependent — which is what
 * we want. So bindings store the typed character.
 *
 * Negative-space rules enforced here (any caller seeing a non-null
 * chord can trust these have been checked):
 *
 *   1. Empty / whitespace-only string  → `null` (treated as "unset").
 *      This is the explicit-unset path; `null` is a valid binding
 *      value meaning "no hotkey", and the recorder uses this too.
 *
 *   2. Only modifiers, no key          → reject (returns `null`).
 *      A chord without a non-modifier key can never fire — the user
 *      almost certainly didn't mean it.
 *
 *   3. Unmodified printable character  → reject. Plain `b` would
 *      trigger on every "b" the user types. Unmodified non-printable
 *      keys (Escape, F1–F24, ArrowUp, …) ARE allowed: they don't
 *      collide with typing and are useful for e.g. pop-up dismissal.
 *
 *   4. Duplicate modifiers             → merged. "mod+mod+b" → "mod+b".
 *
 *   5. Unknown token                   → reject. We don't try to guess
 *      — silently dropping a token would let the user save a binding
 *      that does something different from what they think.
 *
 * Output normalisation: modifiers always serialise in the canonical
 * order `mod, ctrl, alt, shift, key`. Two different inputs that mean
 * the same chord therefore produce the same normalised string, which
 * is what the conflict detector relies on.
 */

import type { Chord } from './types';

/**
 * `KeyboardEvent.key` returns visual names for non-printables (`Escape`,
 * `ArrowUp`, `Enter`, ` `) and the typed character otherwise. We
 * canonicalise the unprintables to lowercase tokens so the binding
 * string matches what the user wrote: `"escape"`, `"arrowup"`, `"enter"`,
 * `"space"`. Printable characters stay as-is, lowercased.
 *
 * Bidirectional: same table also drives the formatter — see
 * `format.ts` — and the matcher in `manager.svelte.ts`.
 */
const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  pageup: 'pageup',
  pagedown: 'pagedown',
  '+': 'plus',
  '-': 'minus'
};

/**
 * Keys that *don't* produce text when typed unmodified, and are
 * therefore safe to bind without any modifier. Everything else (letters,
 * digits, punctuation) MUST carry at least one modifier; the parser
 * rejects unmodified printable bindings to stop the user from
 * accidentally locking themselves out of typing the letter "b".
 */
const NON_PRINTABLE_KEYS = new Set<string>([
  'escape',
  'enter',
  'tab',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
  'f13',
  'f14',
  'f15',
  'f16',
  'f17',
  'f18',
  'f19',
  'f20',
  'f21',
  'f22',
  'f23',
  'f24'
]);

const MODIFIER_TOKENS = new Set(['mod', 'ctrl', 'control', 'alt', 'shift']);

/**
 * Build an empty chord. All flags false, key empty — passing this to
 * the matcher will never fire (no key). Use as a starting point for
 * accumulating modifiers and a typed key inside the recorder.
 */
function blankChord(): Chord {
  return { mod: false, ctrl: false, alt: false, shift: false, key: '' };
}

/**
 * Normalize a single token. Modifiers map to themselves; everything
 * else goes through KEY_ALIASES then `toLowerCase()`. Empty / whitespace
 * input returns `null` so the caller can reject the whole binding.
 */
function normalizeToken(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (t.length === 0) return null;
  if (KEY_ALIASES[t]) return KEY_ALIASES[t];
  return t;
}

/**
 * Parse an author-facing binding string. Returns `null` for any of:
 *   - empty / whitespace input (explicit unset)
 *   - missing non-modifier key
 *   - unmodified printable key
 *   - unknown token
 *
 * The caller decides whether `null` means "leave as-is" or "treat as
 * unset"; the store treats it as unset.
 */
export function parseBinding(input: string): Chord | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Don't split on `+` directly — that loses the literal `+` key (e.g.
  // "ctrl++"). When the input ends in `++` the trailing pair is one
  // separator + the literal plus token, so we strip the whole pair from
  // the prefix and append `+` as its own token.
  let body = trimmed;
  let trailingPlus = false;
  if (body.endsWith('++') && body.length >= 2) {
    body = body.slice(0, -2);
    trailingPlus = true;
  }
  const rawTokens = body.length > 0 ? body.split('+') : [];
  if (trailingPlus) rawTokens.push('+');

  const chord = blankChord();
  const keyTokens: string[] = [];

  for (const raw of rawTokens) {
    const token = normalizeToken(raw);
    if (token === null) return null;
    if (MODIFIER_TOKENS.has(token)) {
      // Aliases for the same modifier merge silently — "ctrl"/"control"
      // both set `ctrl`, duplicates are idempotent.
      if (token === 'mod') chord.mod = true;
      else if (token === 'ctrl' || token === 'control') chord.ctrl = true;
      else if (token === 'alt') chord.alt = true;
      else if (token === 'shift') chord.shift = true;
    } else {
      keyTokens.push(token);
    }
  }

  // Exactly one key required. Zero → "modifiers only" (rule 2). More
  // than one → ambiguous (e.g. "mod+b+c"); reject rather than guess.
  if (keyTokens.length !== 1) return null;
  chord.key = keyTokens[0];

  // Reject unmodified printable letters/digits/punctuation. The
  // non-printable set covers Escape, function keys, arrows, etc. —
  // they have no typing collision so they're safe to bind alone.
  const anyModifier = chord.mod || chord.ctrl || chord.alt || chord.shift;
  if (!anyModifier && !NON_PRINTABLE_KEYS.has(chord.key)) return null;

  return chord;
}

/**
 * Stringify a chord back to canonical form. The same chord always
 * produces the same string — that property is what
 * `bindingsConflict()` and the registry's reverse-lookup map rely on.
 *
 * Format mirrors the parser's grammar: tokens joined by `+`, modifier
 * order `mod, ctrl, alt, shift`, key last.
 */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('mod');
  if (chord.ctrl) parts.push('ctrl');
  if (chord.alt) parts.push('alt');
  if (chord.shift) parts.push('shift');
  parts.push(chord.key);
  return parts.join('+');
}

/**
 * Two bindings collide when, after parsing, they produce identical
 * chords. We compare via the canonical string rather than field-by-field
 * so adding a new modifier later (e.g. AltGr) only requires updating
 * `formatChord` — the conflict check picks it up automatically.
 *
 * Both `null` is not a conflict (both unset). Anything that fails to
 * parse is treated as non-conflicting with everything — `null` ⇒ this
 * binding can't fire anyway, so it can't collide.
 */
export function bindingsConflict(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const pa = parseBinding(a);
  const pb = parseBinding(b);
  if (!pa || !pb) return false;
  return formatChord(pa) === formatChord(pb);
}

/**
 * Convenience for round-tripping a possibly-user-edited binding into
 * canonical form. `null` passes through unchanged. Invalid input also
 * becomes `null` so storing the return value never persists garbage.
 */
export function canonicalize(binding: string | null): string | null {
  if (binding === null) return null;
  const chord = parseBinding(binding);
  return chord ? formatChord(chord) : null;
}

export { NON_PRINTABLE_KEYS, KEY_ALIASES };
