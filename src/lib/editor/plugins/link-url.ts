/**
 * Encoding for the value carried in a `mindstream://` href.
 *
 * `encodeURIComponent` alone is not enough. It deliberately leaves the
 * sub-delimiters `!'()*` unescaped — they're legal in a URI path — but a
 * parenthesis is exactly what terminates a markdown link destination. The
 * source plugins write `[label](<href>)` as literal text, so an id or username
 * containing `)` would end the link early and spill the rest of the URL into
 * the document as visible text. (The prose plugins are accidentally safe here:
 * they store the href as a mark attribute and let remark-stringify decide how
 * to quote it. Encoding at this shared layer means neither surface has to
 * think about it, and the two can't disagree about what a given id encodes to.)
 *
 * Percent-escaping the parens rather than backslash-escaping them keeps the
 * round-trip trivial: `decodeURIComponent` reverses this, so the existing
 * parse helpers need no matching special case.
 */

/**
 * Percent-encode `value` for use as the path segment of a `mindstream://` URL,
 * including the parens `encodeURIComponent` would otherwise pass through.
 * Reversed by `decodeURIComponent`.
 */
export function encodeLinkValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
