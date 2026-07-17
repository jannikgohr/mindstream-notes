/**
 * Escaping for the label of a markdown link the source plugins write.
 *
 * The prose plugins never need this: they insert the label as a ProseMirror
 * text node carrying a link mark, and the serializer escapes whatever it has
 * to on the way out. The source plugins write raw markdown straight into the
 * document, so an unescaped title is a broken link — a note called
 * `Foo [bar]` would otherwise commit as `[Foo [bar]](mindstream://note/…)`,
 * whose label ends at the first `]`, leaving `](mindstream://note/…)` as
 * literal text on the page.
 *
 * Only brackets and the escape character itself matter here — this is the
 * label half. The destination half has the same problem with parens and is
 * handled at the shared href layer instead, by `../link-url`.
 */

/** Backslash-escape the characters that would terminate a link label early. */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, '\\$&');
}
