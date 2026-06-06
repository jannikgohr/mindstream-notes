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
