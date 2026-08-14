/**
 * The shared vocabulary for text diagnostics — squiggles under misspelled
 * words, grammar hints, style notes.
 *
 * Everything that can flag a span of text speaks this one language: the
 * built-in dictionary checker, the LanguageTool plugin, anything a plugin
 * contributes later. That is deliberate. The app used to lean on the
 * webview's native spellcheck, which meant the rendering, the suggestion
 * menu and the "add to dictionary" store all lived inside the browser and
 * differed per platform — and in PROD builds were unreachable anyway,
 * since the root layout suppresses the native context menu.
 *
 * Owning the model means one decoration style, one popover, one custom
 * dictionary, identical on every platform, and a new checker only has to
 * produce `Diagnostic[]` to light up the whole UI.
 *
 * OFFSETS: `from`/`to` are absolute offsets into the *document text* the
 * caller passed in, using the same units the caller uses. The source
 * (CodeMirror) surface works in string indices; the WYSIWYG surface works
 * in ProseMirror positions and maps them at its own boundary. The bus
 * never invents offsets — providers report positions relative to the
 * segment they were given and the bus rebases them by that segment's
 * offset, so the arithmetic stays in one place.
 */

/**
 * What kind of problem a diagnostic reports. Used for styling (spelling
 * gets the classic red squiggle, grammar/style get calmer treatments) and
 * for precedence when two providers flag the same span — see
 * `resolveOverlaps` in `bus.ts`.
 */
export type DiagnosticKind = 'spelling' | 'grammar' | 'style';

/** Half-open text span, `[from, to)`. */
export interface TextRange {
  from: number;
  to: number;
}

export interface Diagnostic extends TextRange {
  kind: DiagnosticKind;
  /**
   * Human-readable, already localized by whoever produced it. Providers
   * own their own wording — the built-in checker goes through the app's
   * i18n, a plugin through its contributed bundle, LanguageTool returns
   * server-side strings in the requested language.
   */
  message: string;
  /**
   * Suggested corrections, best first. May be empty: a provider is
   * allowed to know a word is wrong without knowing the fix, and
   * computing suggestions is often far more expensive than checking
   * (spellbook is ~10µs to check a word but tens of milliseconds to
   * suggest one), so providers may defer them to an explicit request.
   */
  replacements: string[];
  /** Id of the provider that produced this. Shown in the popover. */
  source: string;
}

/**
 * One unit of text handed to a provider — in practice a paragraph.
 *
 * Segmenting matters for more than tidiness: it is what makes caching and
 * incremental re-checking possible. Editing one paragraph only
 * invalidates that paragraph's cache entry, so a keystroke costs one
 * segment check rather than a whole-document pass.
 */
export interface Segment extends TextRange {
  text: string;
}

export interface CheckRequest {
  /** The segment's text, standalone — providers must not assume context. */
  text: string;
  /**
   * BCP-47 tags the user has enabled, e.g. `['de-DE', 'en-US']`.
   *
   * A word is correct if ANY enabled language accepts it. That rule is
   * the whole multilingual story: no per-paragraph language detection, no
   * `lang` attributes, no platform-specific dictionary negotiation. It
   * trades false negatives (a German word that happens to be a valid
   * English word passes) for far fewer false positives, which is the
   * right way round for a notes app where a spurious squiggle is much
   * more annoying than a missed typo.
   */
  languages: string[];
  /**
   * Aborted when the text changes underneath an in-flight check. Providers
   * doing real work (network calls, long suggestion searches) must honour
   * it; cheap synchronous ones can ignore it.
   */
  signal: AbortSignal;
}

export interface DiagnosticProvider {
  /** Stable id, also used as `Diagnostic.source` and for cache keys. */
  id: string;
  /**
   * Which kinds this provider may emit. Declared up front so overlapping
   * providers can be de-conflicted without running them — e.g. when
   * LanguageTool covers grammar, its spelling rules are switched off
   * rather than reported and then discarded.
   */
  kinds: readonly DiagnosticKind[];
  /**
   * Ranges are relative to `request.text`, NOT to the document; the bus
   * rebases them. Returning positions already rebased will place the
   * squiggle in the wrong place on every paragraph but the first.
   *
   * Return `null` for "I did not check this", which is NOT the same as an
   * empty array. An empty array is a verdict — nothing is wrong here — and
   * a provider that owns a kind uses it to suppress the others. `null` says
   * the provider had no opinion at all (unconfigured, offline, nothing
   * applicable), so whoever else was asked still counts. Confusing the two
   * makes an idle checker silence a working one.
   */
  check(
    request: CheckRequest
  ): Promise<Diagnostic[] | null> | Diagnostic[] | null;
}
