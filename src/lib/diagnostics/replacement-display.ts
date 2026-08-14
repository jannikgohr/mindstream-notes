/**
 * Making a suggestion's whitespace visible.
 *
 * LanguageTool's punctuation rules suggest replacements that differ only in
 * which space character they use — a plain space versus a narrow no-break
 * space, say. Rendered literally, two options look identical, or one shows
 * as a tofu box, and the user has no way to tell which is which or what
 * they are choosing.
 *
 * Only affects DISPLAY. The value applied to the document is always the
 * server's original string.
 */

/** A run of a replacement, split so whitespace can be rendered differently. */
export interface ReplacementPart {
  text: string;
  /** Set for whitespace runs; names the character for a tooltip. */
  space?: string;
}

/**
 * Glyphs standing in for whitespace, and the names shown on hover.
 *
 * A plain space gets a faint middot rather than a box: it is by far the
 * common case, so it has to stay unobtrusive while still being visible
 * enough to distinguish from its exotic cousins.
 */
const SPACES: Record<string, { glyph: string; name: string }> = {
  ' ': { glyph: '·', name: 'space' },
  // Every non-plain space is written as a codepoint on purpose: an
  // invisible or control character sitting literally in source is
  // unreadable, and trivially mangled by any tool that touches the file.
  [String.fromCharCode(9)]: { glyph: '⇥', name: 'tab' },
  [String.fromCharCode(10)]: { glyph: '↵', name: 'line break' },
  [String.fromCharCode(0x00a0)]: { glyph: '⍽', name: 'no-break space' },
  [String.fromCharCode(0x202f)]: {
    glyph: '⍽',
    name: 'narrow no-break space'
  },
  [String.fromCharCode(0x2009)]: { glyph: '⍽', name: 'thin space' },
  [String.fromCharCode(0x2007)]: { glyph: '⍽', name: 'figure space' },
  [String.fromCharCode(0x200a)]: { glyph: '⍽', name: 'hair space' }
};

/** Split a replacement into text and whitespace runs, in order. */
export function replacementParts(value: string): ReplacementPart[] {
  const parts: ReplacementPart[] = [];
  for (const char of value) {
    const space = SPACES[char];
    const last = parts[parts.length - 1];
    if (space) {
      // Each space character is its own part: a run of two different space
      // characters must not be merged into one indistinguishable blob.
      parts.push({ text: space.glyph, space: space.name });
      continue;
    }
    if (last && last.space === undefined) last.text += char;
    else parts.push({ text: char });
  }
  return parts;
}

/**
 * True when a replacement would be ambiguous or invisible shown as-is.
 *
 * Used to decide whether the extra rendering is worth it — an ordinary
 * one-word correction should look like a word, not like a diagram.
 */
export function needsWhitespaceMarkers(value: string): boolean {
  return [...value].some((char) => char in SPACES);
}
