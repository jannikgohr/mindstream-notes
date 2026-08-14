/**
 * Splitting prose into checkable words.
 *
 * Leaving the webview's spellchecker behind means we inherit the job it
 * used to do silently, and word boundaries are where a spellchecker earns
 * or loses the user's trust. Every rule here exists to suppress a
 * false positive — a squiggle under something that isn't a mistake — because
 * in a notes app those are far more corrosive than a missed typo: a
 * document speckled with red gets the whole feature switched off.
 *
 * The tokenizer is deliberately dumb about language. It does not guess
 * which language a word is in; that is settled downstream by the
 * "any enabled dictionary accepts it" rule (see `CheckRequest.languages`).
 */

import type { TextRange } from './types';

export interface Token extends TextRange {
  text: string;
  /**
   * The token plus its trailing period, when one immediately follows.
   *
   * Hunspell dictionaries store abbreviations WITH the period as the
   * dictionary entry: de_DE_frami contains `Nr.`, `Dr.`, `bzw.`, `usw.` and
   * ~93 others, and does NOT contain the bare stems. Checking only the
   * stripped word therefore flags every abbreviation in the language as a
   * misspelling — and then helpfully suggests the form the user already
   * typed.
   *
   * The period is offered as an ALTERNATIVE rather than folded into `text`,
   * because most words followed by a period are just sentence endings:
   * `gut.` must still be checked as `gut`. A token is only misspelled when
   * neither form is known.
   */
  abbreviation?: string;
}

/**
 * A word may START with a letter or a combining mark, never a digit or
 * punctuation. Requiring a letter first is what keeps `2026`, `3rd` and
 * `v1.2` out without a special case for each.
 */
const WORD_START = /[\p{L}\p{M}]/u;

/** Inside a word we additionally allow digits, so `MP3` stays one token. */
const WORD_INNER = /[\p{L}\p{M}\p{N}]/u;

/**
 * Characters that may sit INSIDE a word but not end it: apostrophes
 * (`don't`, `geht's`, and the typographic `’` that editors auto-insert)
 * and hyphens.
 *
 * Hyphenated words are kept whole rather than split. Hunspell's own `BREAK`
 * directive already handles hyphen splitting inside the dictionary, and it
 * does it better than we can: splitting here would flag the `E` of `E-Mail`
 * as a one-letter typo.
 */
const CONNECTOR = /['’‐‑-]/u;

/**
 * Scripts written without spaces between words. Segmenting these needs a
 * real dictionary-driven word breaker (Intl.Segmenter or ICU), and no
 * Hunspell dictionary checks them anyway — so a naive tokenizer would
 * produce one "word" per run of characters and underline entire sentences.
 * We skip them outright: no diagnostics beats wrong diagnostics.
 */
const SKIP_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const DIGIT = /\p{N}/u;

/**
 * Split identifier-style tokens at case boundaries.
 *
 * `getUserName` is not a misspelling, but no dictionary contains it. Notes
 * are full of this: API names, config keys, class names written in running
 * prose rather than inside a code fence (where `ignore-ranges` would have
 * excluded them). Splitting into `get` / `User` / `Name` lets each part be
 * checked on its own, so the token passes without needing to be in any
 * dictionary — while a genuine typo in one part still gets flagged, with a
 * range covering just that part.
 *
 * Two boundaries: lower→Upper (`userName`) and the tail of an acronym run
 * (`HTMLParser` → `HTML` + `Parser`).
 */
function splitCamelCase(token: Token): Token[] {
  const chars = [...token.text];
  const parts: Token[] = [];
  let start = 0;
  // Walk UTF-16 offsets rather than code-point indices: `from`/`to` are
  // expressed in UTF-16 units, and an emoji or astral character in the
  // token would otherwise desync every subsequent position.
  let offset = 0;
  const cut = (end: number) => {
    if (end > start) {
      parts.push({
        text: token.text.slice(start, end),
        from: token.from + start,
        to: token.from + end
      });
    }
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const isUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
    const prevIsLower =
      prev !== undefined &&
      prev !== prev.toUpperCase() &&
      prev === prev.toLowerCase();
    const nextIsLower =
      next !== undefined &&
      next !== next.toUpperCase() &&
      next === next.toLowerCase();
    const prevIsUpper =
      prev !== undefined &&
      prev !== prev.toLowerCase() &&
      prev === prev.toUpperCase();

    if (isUpper && (prevIsLower || (prevIsUpper && nextIsLower))) {
      cut(offset);
      start = offset;
    }
    offset += ch.length;
  }
  cut(offset);

  return parts.length > 1 ? parts : [token];
}

/**
 * Attach the abbreviation variant to the final part of a token.
 *
 * Only the last part: in `Bestellnr.` the period belongs to the whole
 * token, and after a camelCase split it is `nr` that may carry it, not
 * `Bestell`.
 */
function withAbbreviation(parts: Token[], followedByPeriod: boolean): Token[] {
  const last = parts[parts.length - 1];
  if (!last || !followedByPeriod) return parts;
  return [...parts.slice(0, -1), { ...last, abbreviation: `${last.text}.` }];
}

/**
 * Extract the checkable words from `text`.
 *
 * `offset` is added to every reported position, so callers holding a
 * paragraph out of a larger document get document-absolute ranges back
 * without doing the arithmetic themselves.
 */
export function tokenizeWords(text: string, offset = 0): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (!WORD_START.test(ch) || SKIP_SCRIPT.test(ch)) {
      i += 1;
      continue;
    }

    const start = i;
    let end = i;
    while (i < text.length) {
      const c = text[i];
      if (WORD_INNER.test(c) && !SKIP_SCRIPT.test(c)) {
        i += 1;
        end = i;
        continue;
      }
      // A connector only stays in the word if a word character follows it,
      // so the apostrophe in `'quoted'` and the dash in `word - word` end
      // the token instead of being absorbed into it.
      if (
        CONNECTOR.test(c) &&
        i + 1 < text.length &&
        WORD_INNER.test(text[i + 1])
      ) {
        i += 1;
        continue;
      }
      break;
    }

    const raw = text.slice(start, end);
    // Anything with a digit in it is an identifier, a version, a measurement
    // or a serial — never a word a dictionary should adjudicate. The
    // preceding character counts too: a word can only start on a letter, so
    // the `3` of `3rd` is skipped before the scan begins and `rd` would
    // otherwise look like a perfectly ordinary (misspelled) word.
    const afterDigit = start > 0 && DIGIT.test(text[start - 1]);
    if (raw.length > 0 && !DIGIT.test(raw) && !afterDigit) {
      tokens.push(
        ...withAbbreviation(
          splitCamelCase({
            text: raw,
            from: start + offset,
            to: end + offset
          }),
          // Indexed locally: token positions carry `offset`, this string
          // does not.
          text[end] === '.'
        )
      );
    }
  }

  return tokens;
}
