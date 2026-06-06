/**
 * Human-readable binding rendering.
 *
 *   - macOS: modifier symbols (⌃ ⌥ ⇧ ⌘) concatenated with the key,
 *     no separator — matches Apple HIG and Google Docs' keyboard-shortcut
 *     dialog on Mac.
 *   - everything else: `Ctrl+Shift+B` style — same convention as
 *     Notion, Obsidian, VS Code on Windows/Linux.
 *
 * Two surfaces consume this: the settings list (next to each command
 * row) and the recorder placeholder when the user is about to type.
 * Both call `displayBinding`; nobody else should be re-implementing the
 * rendering rules.
 */

import { isMac } from './platform';
import { parseBinding } from './parse';

/** Pretty names for non-printables. Keys are the lowercased canonical
 *  forms produced by the parser; values are what we show the user. */
const KEY_DISPLAY: Record<string, string> = {
  space: '␣',
  enter: '↵',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌦',
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
  plus: '+',
  minus: '-'
};

function displayKey(key: string): string {
  if (KEY_DISPLAY[key]) return KEY_DISPLAY[key];
  // F-keys keep their uppercase form ("F2"); single characters get
  // upper-cased so "b" → "B".
  return key.length === 1 ? key.toUpperCase() : key.toUpperCase();
}

/**
 * ARIA `aria-keyshortcuts` value names, mapped from our normalised key
 * tokens. The ARIA spec dictates a specific set of named keys
 * (Escape, Enter, Space, ArrowUp/Down/Left/Right, F1–F12, …); the
 * default behaviour for everything else is to use the typed
 * character, upper-cased.
 *
 * Single source so the `displayBinding` table and this one can't
 * silently disagree on what `space` or `arrowup` look like — we just
 * stringify differently.
 */
const ARIA_KEY_NAMES: Record<string, string> = {
  space: 'Space',
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  plus: '+',
  minus: '-'
};

function ariaKeyName(key: string): string {
  if (ARIA_KEY_NAMES[key]) return ARIA_KEY_NAMES[key];
  // F-keys keep their upper form ("F2"); single characters get
  // upper-cased so "b" → "B".
  return key.length === 1 ? key.toUpperCase() : key.toUpperCase();
}

/**
 * Format a binding for the ARIA `aria-keyshortcuts` attribute.
 *
 * Distinct from `displayBinding`:
 *
 *   - `displayBinding` is for sighted users — uses ⌘⇧ glyphs on Mac,
 *     "Ctrl+Shift+B" elsewhere.
 *   - `ariaKeyShortcut` is the form screen readers parse — always
 *     `<Modifier>+<Modifier>+<Key>` with the ARIA-named modifiers
 *     ("Control", "Shift", "Alt", "Meta") regardless of platform.
 *
 * Platform mapping for the `mod` token follows the ARIA convention:
 * "Meta" is the platform meta key (Command on Mac, Super on Linux,
 * Win on Windows). NVDA / JAWS / VoiceOver all respect that.
 *
 * Returns the empty string for null / unparseable bindings so callers
 * can spread the attribute conditionally:
 *
 *     <button aria-keyshortcuts={ariaKeyShortcut(binding) || undefined}>
 *
 * Empty string would otherwise serialise as `aria-keyshortcuts=""`,
 * which some screen readers announce as "no shortcut" — worse than
 * silence.
 */
export function ariaKeyShortcut(binding: string | null): string {
  if (!binding) return '';
  const chord = parseBinding(binding);
  if (!chord) return '';
  const parts: string[] = [];
  if (chord.mod) parts.push(isMac() ? 'Meta' : 'Control');
  if (chord.ctrl) parts.push('Control');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(ariaKeyName(chord.key));
  return parts.join('+');
}

/**
 * Render a binding for display. `null` or invalid input returns the
 * empty string — surfaces should show their own "unset" placeholder in
 * that case rather than relying on a magic value.
 *
 * Re-parses on every call (cheap; bindings are tiny strings) so an
 * out-of-date canonical form (e.g. user types "B+mod") still renders
 * correctly.
 */
export function displayBinding(binding: string | null): string {
  if (!binding) return '';
  const chord = parseBinding(binding);
  if (!chord) return '';

  if (isMac()) {
    // Symbol order matches Apple HIG: Ctrl, Option, Shift, Command, key.
    // We mirror that here so the rendering looks native on macOS.
    let out = '';
    if (chord.ctrl) out += '⌃';
    if (chord.alt) out += '⌥';
    if (chord.shift) out += '⇧';
    if (chord.mod) out += '⌘';
    out += displayKey(chord.key);
    return out;
  }

  // Windows / Linux style. Mod renders as Ctrl on non-mac platforms
  // (because mod === Ctrl there); a separate explicit `ctrl` modifier
  // collapses to a single "Ctrl" — chording Mod+Ctrl on non-mac is
  // semantically the same as Ctrl alone, so we de-dupe.
  const parts: string[] = [];
  const ctrlShown = chord.mod || chord.ctrl;
  if (ctrlShown) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(displayKey(chord.key));
  return parts.join('+');
}
