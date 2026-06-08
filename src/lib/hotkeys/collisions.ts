/**
 * Well-known chord collisions with the OS / window manager.
 *
 * Some chords are intercepted before the webview gets to see them —
 * `Cmd+Space` opens Spotlight, `Alt+Tab` switches windows, `Cmd+Q`
 * quits the app. If the user binds one of these, the hotkey will
 * silently never fire and they'll think the system is broken.
 *
 * This module exposes a single advisory check: given a binding, does
 * it match a chord we know is captured by the platform? Returns a
 * short human-readable reason (or null). Callers — the recorder
 * surface and the hydrate-time console warn — decide what to do with
 * the answer.
 *
 * Why advisory and not blocking:
 *
 *   - In a Tauri build, many "browser" shortcuts (Mod+W, F5, …) DO
 *     reach the webview because there's no host browser around. So
 *     blocking would over-reject.
 *   - The user may genuinely want to bind a chord with a known
 *     conflict — e.g. mapping `Mod+Q` on Linux where it's not
 *     reserved. Rejecting their input would feel paternalistic.
 *   - A list of "definitely-broken" chords is unmaintainable across
 *     OS versions, accessibility modes, keyboard layouts, etc.
 *
 * The list is small on purpose. We only ship entries we're confident
 * about. A false positive (warning the user their binding is broken
 * when it actually works) is annoying; a false negative (no warning
 * for a chord that genuinely won't fire) is just the status quo
 * before this feature shipped.
 */

import { isMac } from './platform';
import { canonicalize, parseBinding } from './parse';

type CollisionPlatform = 'mac' | 'non-mac' | 'any';

interface KnownCollision {
  /** Symbolic binding string in our canonical grammar. */
  binding: string;
  /** Short reason shown to the user. Keep under ~60 chars. */
  reason: string;
  /** Platform gate — non-matching entries are skipped. */
  platform: CollisionPlatform;
}

/**
 * Conservative seed list. Each entry is a chord we're confident the
 * platform captures before the webview, OR captures so frequently
 * that warning the user is worth a small false-positive rate.
 *
 * Order doesn't matter — the first match wins, and the data is
 * authored so no entry should match more than one chord.
 */
const KNOWN: KnownCollision[] = [
  // macOS reserved at the OS level. Cmd+Tab and Cmd+Space are
  // genuinely uninterceptable; the rest can usually be intercepted
  // by an app but Apple ships system-wide behaviour for them and
  // overriding is almost never what the user wants.
  { binding: 'mod+q', reason: 'macOS: quit the app', platform: 'mac' },
  { binding: 'mod+h', reason: 'macOS: hide the app', platform: 'mac' },
  { binding: 'mod+space', reason: 'macOS: Spotlight search', platform: 'mac' },
  { binding: 'mod+tab', reason: 'macOS: switch apps', platform: 'mac' },
  {
    binding: 'mod+shift+3',
    reason: 'macOS: full-screen screenshot',
    platform: 'mac'
  },
  {
    binding: 'mod+shift+4',
    reason: 'macOS: area screenshot',
    platform: 'mac'
  },
  {
    binding: 'mod+shift+5',
    reason: 'macOS: screenshot menu',
    platform: 'mac'
  },

  // Windows / Linux. Alt+Tab is everywhere; Alt+F4 is conventionally
  // close-window on Windows and most Linux desktops.
  {
    binding: 'alt+tab',
    reason: 'Windows / Linux: switch windows',
    platform: 'non-mac'
  },
  {
    binding: 'alt+f4',
    reason: 'Windows / Linux: close window',
    platform: 'non-mac'
  },
  {
    binding: 'ctrl+alt+delete',
    reason: 'Windows: security menu',
    platform: 'non-mac'
  }
];

/**
 * True when the collision applies on the current platform. Encapsulates
 * the `mac` vs `non-mac` split so the lookup loop stays a clean filter.
 */
function appliesHere(entry: KnownCollision, mac: boolean): boolean {
  if (entry.platform === 'any') return true;
  if (entry.platform === 'mac') return mac;
  if (entry.platform === 'non-mac') return !mac;
  return false;
}

/**
 * Look up a binding against the known-conflict list. Returns the
 * reason string the recorder / console-warn should surface, or null
 * if the binding is clear of known conflicts.
 *
 * Null inputs and unparseable bindings short-circuit to null — there's
 * nothing to warn about if the binding can't fire at all.
 *
 * Comparison goes through `canonicalize` so authors don't have to
 * worry about modifier order in either the seed list or the caller's
 * input. `Shift+Mod+B` and `mod+shift+b` resolve identically.
 */
export function wellKnownConflict(binding: string | null): string | null {
  if (!binding) return null;
  const canonical = canonicalize(binding);
  if (!canonical) return null;
  const mac = isMac();
  for (const entry of KNOWN) {
    if (!appliesHere(entry, mac)) continue;
    if (canonicalize(entry.binding) === canonical) return entry.reason;
  }
  return null;
}

/**
 * Test helper: returns the full list of collisions for the current
 * platform. Not exported from the barrel — only the recorder and the
 * test file should care.
 */
export function _knownConflictsForCurrentPlatform(): KnownCollision[] {
  const mac = isMac();
  return KNOWN.filter((e) => appliesHere(e, mac));
}

// Side-export of parseBinding so external test files can verify each
// seed entry parses cleanly without re-importing parse.ts.
export { parseBinding };
