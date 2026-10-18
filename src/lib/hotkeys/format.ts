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
import globalShortcutContract from './global-shortcuts.json';

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

const TAURI_KEY_NAMES: Record<string, string> = {
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

function tauriKeyName(key: string): string {
  if (TAURI_KEY_NAMES[key]) return TAURI_KEY_NAMES[key];
  return key.length === 1 ? key.toUpperCase() : key.toUpperCase();
}

/**
 * Format a binding for Tauri/muda menu accelerators. This is separate
 * from `displayBinding`: native menus need a parseable accelerator
 * string (`CommandOrControl+B`), not a human display string (`⌘B` /
 * `Ctrl+B`).
 *
 * Best-effort — if the key token doesn't map cleanly (e.g. a German
 * umlaut), the result is still produced and muda decides whether to
 * accept it. For OS-level GLOBAL shortcuts use
 * `globalShortcutAccelerator` instead; the global-hotkey plugin's
 * vocabulary is much narrower and we validate against it explicitly.
 */
export function tauriAccelerator(binding: string | null): string | null {
  if (!binding) return null;
  const chord = parseBinding(binding);
  if (!chord) return null;
  const parts: string[] = [];
  if (chord.mod) parts.push('CommandOrControl');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(tauriKeyName(chord.key));
  return parts.join('+');
}

/**
 * Typed-character key tokens (lower-cased, as parser-normalised) →
 * the accelerator key name accepted by the global-hotkey plugin used
 * by `tauri_plugin_global_shortcut`.
 *
 * Source: the plugin's own `keyToCodeMap` (Tauri 2.x). Empirically
 * verified: any key OUTSIDE this set either fails to register or —
 * worse — registers silently but never dispatches (the Pressed
 * callback simply never fires when the user hits the chord), which is
 * the trap we ran into trying to bind `Ctrl+Alt+Ö` (Semicolon
 * physical position on QWERTZ). So instead of silently registering an
 * unsupported chord, we reject it at the UI layer and ask the user
 * to pick something the plugin actually dispatches.
 *
 * The map IS the contract: any addition / removal here must be
 * tested against the plugin's actual behaviour, not just whether
 * `on_shortcut` returns Ok.
 */
const GLOBAL_SHORTCUT_KEY_MAP: Record<string, string> =
  globalShortcutContract.keys;

/** Reason codes returned by `globalShortcutSupportReason`. Surfaced
 *  as-is to the i18n layer so each case can have a tailored message. */
export type GlobalShortcutUnsupportedReason = 'unsupported-key';

/**
 * Check whether a binding can be registered as an OS-level global
 * shortcut. Returns `null` when it can — i.e. every key token maps
 * cleanly into the plugin's vocabulary — and a reason code otherwise.
 *
 * Modifier-only or unparseable bindings are also considered
 * unsupported; the recorder's chord-validity check should already
 * have rejected those before this is called, but we treat them as
 * not-registerable for safety.
 */
export function globalShortcutSupportReason(
  binding: string | null
): GlobalShortcutUnsupportedReason | null {
  if (!binding) return 'unsupported-key';
  const chord = parseBinding(binding);
  if (!chord) return 'unsupported-key';
  if (!(chord.key in GLOBAL_SHORTCUT_KEY_MAP)) return 'unsupported-key';
  return null;
}

/**
 * Build the accelerator string for the OS-level global-shortcut
 * registration. Returns `null` for any binding whose key isn't in
 * `GLOBAL_SHORTCUT_KEY_MAP` — the +layout.svelte sync skips those
 * rather than handing the plugin a chord that would register silently
 * and never fire.
 *
 * Distinct from `tauriAccelerator`: that one is best-effort for muda
 * menu accelerators, where a wrong string just falls back to "no
 * accelerator displayed in the menu". Global registration HAS to be
 * correct — a silent miss is the bug we're fixing.
 */
export function globalShortcutAccelerator(
  binding: string | null
): string | null {
  if (!binding) return null;
  const chord = parseBinding(binding);
  if (!chord) return null;
  const keyName = GLOBAL_SHORTCUT_KEY_MAP[chord.key];
  if (!keyName) return null;
  const parts: string[] = [];
  if (chord.mod) parts.push('CommandOrControl');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(keyName);
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
