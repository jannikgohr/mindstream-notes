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
  /**
   * The token's segments — present only when it actually decomposes.
   *
   * Two splitters feed this: the non-letter characters a dictionary
   * declared via `WORDCHARS`, and camelCase boundaries. Neither replaces
   * the token, because a word the user has personally accepted
   * (`MindstreamNotes`) or that a dictionary knows as a compound has to be
   * recognisable in the form it was written in. A token is judged as a
   * whole first; only if no whole form is accepted are the segments judged
   * individually, which narrows the squiggle to the bad segment without
   * ever producing one the whole-word check would not have.
   *
   * The `WORDCHARS` half also keeps a unioned directive safe: it is
   * unioned across every enabled language, so enabling Dutch (which
   * declares `/`) must not turn `and/or` into one unknown token in English
   * text.
   */
  parts?: Token[];
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
 * Characters a dictionary declared as part of a word via `WORDCHARS`.
 *
 * Hunspell has no tokenizer; it exports this so callers segment text the way
 * the dictionary expects. German, Danish, French, Dutch and Swedish all list
 * `.`, which is why `Nr.` and `z.B.` are entries at all. Letters and digits
 * are already word characters, so only the punctuation matters here.
 */
function extraWordChars(wordChars: string): Set<string> {
  // Letters and digits are already word characters. Built-in connectors
  // are excluded too: they already join, and they must never become
  // split points — German declares `-` in WORDCHARS, and splitting there
  // would make `E-Mail` fall back to `E` + `Mail` and flag the `E`.
  return new Set(
    [...wordChars].filter(
      (ch) => !/[\p{L}\p{M}\p{N}]/u.test(ch) && !CONNECTOR.test(ch)
    )
  );
}

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
 * The split is a FALLBACK, recorded in `parts` rather than replacing the
 * token. It used to replace it, and that made a personal-dictionary entry
 * like `MindstreamNotes` unusable: the whole word was gone before anything
 * could ask whether the user had accepted it, so `Mindstream` got flagged
 * on its own.
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
 * Attach the abbreviation variant to a token and to its final segment.
 *
 * Both levels, because both get asked: the whole `Bestellnr.` is checked
 * first, and if that is unknown the fallback needs `nr.`. The period
 * belongs to the end of the word either way, never to `Bestell`.
 */
function withAbbreviation(token: Token, followedByPeriod: boolean): Token {
  if (!followedByPeriod) return token;
  const abbreviated: Token = { ...token, abbreviation: `${token.text}.` };
  const parts = abbreviated.parts;
  if (!parts) return abbreviated;
  const last = parts[parts.length - 1];
  return {
    ...abbreviated,
    parts: [...parts.slice(0, -1), { ...last, abbreviation: `${last.text}.` }]
  };
}

/**
 * Split a token at the WORDCHARS-derived characters that joined it.
 *
 * Only those characters — never the built-in connectors. Splitting at
 * hyphens or apostrophes would undo two deliberate behaviours: `E-Mail`
 * stays whole because Hunspell's BREAK handles hyphens better than we can,
 * and `don't` must never fall back to `don` + `t`.
 */
function splitAtExtras(token: Token, extra: Set<string>): Token[] {
  if (extra.size === 0 || ![...token.text].some((ch) => extra.has(ch))) {
    return [token];
  }

  const parts: Token[] = [];
  let start = 0;
  for (let i = 0; i <= token.text.length; i++) {
    if (i === token.text.length || extra.has(token.text[i])) {
      if (i > start) {
        parts.push({
          text: token.text.slice(start, i),
          from: token.from + start,
          to: token.from + i
        });
      }
      start = i + 1;
    }
  }

  return parts.length > 1 ? parts : [token];
}

/**
 * The segments a token decomposes into, or nothing when it does not.
 *
 * WORDCHARS first and camelCase inside each piece, so `z.BMeinWort` yields
 * leaves rather than a nested tree — the consumer wants a flat list of
 * forms it can ask the dictionary about.
 */
function segments(token: Token, extra: Set<string>): Token[] | undefined {
  const parts = splitAtExtras(token, extra).flatMap(splitCamelCase);
  return parts.length > 1 ? parts : undefined;
}

/**
 * Extract the checkable words from `text`.
 *
 * `offset` is added to every reported position, so callers holding a
 * paragraph out of a larger document get document-absolute ranges back
 * without doing the arithmetic themselves.
 */
export function tokenizeWords(
  text: string,
  offset = 0,
  wordChars = ''
): Token[] {
  const extra = extraWordChars(wordChars);
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
      // A dictionary-declared word character joins on exactly the same
      // terms as the built-in connectors: only when a word character
      // follows. That is what separates `z.B` from the `. ` that ends a
      // sentence.
      if (
        (CONNECTOR.test(c) || extra.has(c)) &&
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
      const whole: Token = {
        text: raw,
        from: start + offset,
        to: end + offset
      };
      const parts = segments(whole, extra);
      tokens.push(
        withAbbreviation(
          parts ? { ...whole, parts } : whole,
          // Indexed locally: token positions carry `offset`, this string
          // does not.
          text[end] === '.'
        )
      );
    }
  }

  return tokens;
}
