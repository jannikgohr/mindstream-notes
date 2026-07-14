/**
 * Note-link href neutraliser.
 *
 * Note links are stored as `[Title](mindstream://note/<id>)`. That
 * `mindstream://` scheme is an internal sentinel, never a real URL —
 * assets are fetched through the platform-rewritten
 * `http://mindstream.localhost/…` form instead (see assets/bridge.ts).
 * If the rendered `<a>` keeps the raw scheme as its href, tapping it on
 * the Android WebView triggers a top-level navigation to an unknown
 * scheme (`ERR_UNKNOWN_URL_SCHEME`) and white-screens the app — and JS
 * `preventDefault` doesn't reliably cancel that native navigation.
 *
 * So override the commonmark link schema's `toDOM` to drop `href` for
 * note links (stashing the original on `data-note-href`) while leaving
 * `mark.attrs` — and therefore markdown serialisation via `toMarkdown` —
 * untouched. Opening still flows through the wikilink decoration's
 * `data-note-id` + click handler, neither of which reads the anchor href.
 */

import type { Editor } from '@milkdown/kit/core';
import { linkAttr, linkSchema } from '@milkdown/kit/preset/commonmark';
import { parseNoteHref, parseUserHref } from './plugins';

/**
 * Register the schema override on a Milkdown editor. Must run before
 * `editor.create()` builds the ProseMirror schema — Crepe's config
 * actions all run at create time, so calling this any time before
 * `crepe.create()` is fine.
 */
export function useNoteLinkHrefNeutralizer(editor: Editor): void {
  editor.config((ctx) => {
    const buildLinkSchema = ctx.get(linkSchema.key);
    ctx.set(linkSchema.key, (schemaCtx) => {
      const base = buildLinkSchema(schemaCtx);
      return {
        ...base,
        toDOM: (mark) => {
          const attrs: Record<string, unknown> = {
            ...schemaCtx.get(linkAttr.key)(mark),
            ...mark.attrs
          };
          // Note links and user mentions both use internal `mindstream://`
          // schemes that must never render as a navigable href (see the file
          // header). Stash the original and drop `href` for both.
          if (
            parseNoteHref(mark.attrs.href) ||
            parseUserHref(mark.attrs.href)
          ) {
            attrs['data-note-href'] = attrs.href;
            delete attrs.href;
          }
          return ['a', attrs, 0];
        }
      };
    });
  });
}
