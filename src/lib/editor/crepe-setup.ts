/**
 * Single place that decides what a fresh Crepe editor looks like for a
 * note in this app. The NoteEditor component only deals with mount /
 * teardown / save lifecycle — every "what features are on, what plugins
 * load, how images persist" decision lives here so adding a new toggle
 * is a one-file change.
 *
 * Why a factory and not a const config:
 *   - The image-block hooks close over a per-note `AssetBridge`
 *     (uploads carry the right `owning_note_id`), so the config is
 *     unique per editor instance.
 *   - The feature flags are read from settings at construct time —
 *     Crepe doesn't let us flip features after `.create()` short of
 *     rebuilding the editor (which would discard live collab state),
 *     so toggles like `editor.math` only apply on the next note open.
 *     Keeping the resolution here means consumers can't drift.
 */

import { Crepe, type CrepeFeature } from '@milkdown/crepe';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark';
import { collab } from '@milkdown/plugin-collab';
// Imported via the kit subpath rather than `@milkdown/plugin-listener`
// directly — keeps us from declaring a transitive dep that's already
// bundled through @milkdown/kit.
import { listener } from '@milkdown/kit/plugin/listener';
import type { AssetBridge } from '$lib/assets/bridge';
import { tUi } from '$lib/settings/i18n.svelte';
import {
  addMermaidMenuItem,
  autoPair,
  installBlockHandleGuard,
  installSelectionToolbarAutoHide,
  isEmptyParagraph,
  markdownSearchPlugins,
  mermaidLanguageDescription,
  preserveBlankLines,
  renderMermaidPreview,
  stripPastedInterBlockWhitespace,
  userMentionPlugins,
  wikilinkPlugins,
  type MarkdownSearchBridge,
  type UserMentionBridge,
  type WikilinkBridge
} from './plugins';
import { useNoteLinkHrefNeutralizer } from './note-link-schema';

export interface CrepeSetupOptions {
  /** Mount point; Crepe owns the DOM under it. */
  host: HTMLElement;
  /**
   * Mobile gets a different feature set:
   *   - BlockEdit is off (block-handle is a hover affordance + the slash
   *     menu is awkward on a soft keyboard).
   * The host should also carry the `.mobile-editor` CSS class so the 90px
   * ProseMirror side padding (left intentionally for the desktop block
   * handle) gets zeroed.
   */
  mobile: boolean;
  /** Bundles the KaTeX node + tooltip. Off → math syntax shows raw. */
  mathEnabled: boolean;
  /** When false, the auto-pair plugin isn't even registered. */
  autoPairEnabled: boolean;
  /**
   * Render ```` ```mermaid ```` fences as SVG diagrams below the code.
   * Implemented via Crepe's CodeMirror `renderPreview` hook (Mermaid
   * isn't a Crepe feature flag — see `plugins/mermaid.ts`). When off
   * we don't register the callback at all so the heavyweight
   * `mermaid` module never loads.
   */
  mermaidEnabled: boolean;
  /**
   * Wikilinks: `[[Note Title]]` autocomplete + click-to-open. When
   * enabled, the caller MUST pass a freshly-created `WikilinkBridge`
   * — it carries the per-editor menu state that the popup component
   * also reads. Without the bridge there's no way for the popup to
   * receive open/close/highlight signals.
   */
  wikilinksEnabled: boolean;
  /** True when plain left-click should follow note links. */
  wikilinkOpenOnClick: () => boolean;
  wikilinkBridge: WikilinkBridge | null;
  /**
   * User mentions: `@username` autocomplete + self-highlighting. When enabled,
   * the caller MUST pass a freshly-created `UserMentionBridge` (per-editor menu
   * state the popup component also reads) and a `currentUsername` getter (whose
   * mention gets the "self" highlight).
   */
  userMentionsEnabled: boolean;
  userMentionBridge: UserMentionBridge | null;
  currentUsername: () => string | null;
  /**
   * Per-editor bridge for in-document find & replace. The host
   * (`NoteEditor`) creates it, drives the shared `FindBar` from its
   * reactive state, and the registered search plugin reports match
   * counts back through it. Always registered — find is core editor
   * behaviour, not a gated feature.
   */
  searchBridge: MarkdownSearchBridge;
  /**
   * Drives Crepe's ImageBlock feature. The bridge persists dropped /
   * pasted images into the encrypted SQLite assets table and resolves
   * `asset:mindstream/<id>` URLs back into blob URLs at render time.
   * One bridge per note so uploads route correctly and the blob-URL
   * cache disposes cleanly on editor unmount.
   */
  assetBridge: AssetBridge;
}

/**
 * Build and return a Crepe instance with our standard plugin stack
 * applied. Caller is responsible for awaiting `crepe.create()` and for
 * teardown via `crepe.destroy()`.
 */
export function buildCrepe(opts: CrepeSetupOptions): Crepe {
  // Keep the block-handle "+" button from firing on a pointerup whose
  // gesture started elsewhere (e.g. releasing a text-selection drag
  // over the hover handle). Document-level and idempotent, so multiple
  // editors share one guard.
  installBlockHandleGuard(opts.host.ownerDocument);

  // Hide the selection toolbar when the user clicks outside the editor
  // — Crepe only re-evaluates it on transactions, so it otherwise
  // lingers (and eats the next click under it).
  installSelectionToolbarAutoHide(opts.host);

  const features: Partial<Record<CrepeFeature, boolean>> = {};
  if (opts.mobile) features[Crepe.Feature.BlockEdit] = false;
  if (!opts.mathEnabled) features[Crepe.Feature.Latex] = false;

  const imageBlockConfig = {
    onUpload: opts.assetBridge.uploadFile,
    // Crepe exposes separate hooks for inline vs block image — both
    // route through the same upload path so the `asset:` URL ends up
    // in the markdown either way.
    inlineOnUpload: opts.assetBridge.uploadFile,
    blockOnUpload: opts.assetBridge.uploadFile,
    proxyDomURL: opts.assetBridge.resolveUrl
  };

  const crepe = new Crepe({
    root: opts.host,
    defaultValue: '',
    features: Object.keys(features).length > 0 ? features : undefined,
    featureConfigs: {
      [Crepe.Feature.ImageBlock]: imageBlockConfig,
      ...(opts.mermaidEnabled
        ? {
            [Crepe.Feature.CodeMirror]: {
              renderPreview: renderMermaidPreview,
              // Surface Mermaid in the code-block language dropdown.
              // Without an entry here the picker shows "No result" for
              // any search — the user can still type `mermaid` into the
              // input field (or use the slash menu / toolbar), but the
              // entry-in-the-list path goes through this array.
              languages: [mermaidLanguageDescription]
            },
            // BlockEdit hosts Crepe's "/" slash menu. We extend the
            // existing Advanced group with a "Mermaid diagram" entry
            // so the feature is discoverable without users having to
            // know the `mermaid` language string. Skipped on mobile
            // because BlockEdit itself is off there.
            ...(opts.mobile
              ? {}
              : {
                  [Crepe.Feature.BlockEdit]: {
                    buildMenu: (builder) => {
                      addMermaidMenuItem(builder, tUi('editor.menu.mermaid'));
                    }
                  }
                })
          }
        : {})
    }
  });

  // Note-link anchors must not carry a navigable `mindstream://` href, or
  // tapping one white-screens the Android WebView — see the helper for the
  // full rationale. Registered before create() builds the schema.
  useNoteLinkHrefNeutralizer(crepe.editor);

  // Serializer style. `getMarkdown()` output feeds the raw Source editor, the
  // saved note body, history diffs and exports, so a clean, conventional and
  // STABLE style matters everywhere. Milkdown's defaults are inconsistent
  // (`*` bullets, tab-indented list continuation) and, worse, it serializes
  // bullet lists LOOSE — a blank line between every item — while ordered lists
  // come out tight. We pin a tidy CommonMark style and force tight lists.
  //
  // `ctx.update` spreads the previous value so Milkdown's internal `handlers` /
  // `encode` entries are preserved.
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({
      ...prev,
      bullet: '-' as const,
      bulletOrdered: '.' as const,
      listItemIndent: 'one' as const,
      fences: true,
      rule: '-' as const,
      ruleRepetition: 3,
      ruleSpaces: false,
      incrementListMarker: true,
      // `join` decides how many blank lines go between two siblings (a return
      // of n emits n blank lines; `undefined` = no opinion, use the default 1).
      join: [
        (left: unknown, _right: unknown, parent: { type?: string }) => {
          // Tight lists: 0 blank lines between a list's items, regardless of
          // the mdast `spread` flag Crepe sets. Only sibling *items* are
          // affected; blocks nested inside an item (parent `listItem`) fall
          // through to the default, so a multi-paragraph item still breaks.
          if (parent?.type === 'list') return 0;
          // Empty paragraphs are how we carry blank lines (see
          // plugins/blank-lines.ts). Each one already renders as an empty
          // string, so the default separator around it would double-count:
          // suppressing the blank line AFTER one makes k empty paragraphs emit
          // exactly k + 1 blank lines — the inverse of the parse plugin.
          if (isEmptyParagraph(left)) return 0;
          return undefined;
        }
      ]
    }));
  });

  // Drop Milkdown's "preserve empty line" plugin.
  //
  // It round-trips an EMPTY PARAGRAPH through markdown by serializing it to a
  // literal `<br />` (preset-commonmark serializes `content.size === 0` →
  // `state.addNode('html', …, '<br />')`) and stripping that html node back out
  // on parse. That hack is invisible while WYSIWYG is the only surface, but it
  // leaks badly now that the raw markdown is editable:
  //
  //   - pressing Enter a few times in WYSIWYG litters the Source pane with
  //     `<br />` noise that isn't really markdown, and
  //   - deleting it in Source doesn't stick when a peer is in WYSIWYG: their
  //     editor re-creates the empty paragraph, which re-emits `<br />` over
  //     collab, so the line break "comes back" every time it's removed.
  //
  // We replace it with `preserveBlankLines` below, which carries the same
  // information symmetrically in the blank lines themselves (k empty
  // paragraphs <-> k + 1 blank lines) instead of smuggling HTML into the doc.
  crepe.editor.remove(remarkPreserveEmptyLinePlugin);
  crepe.editor.use(preserveBlankLines);

  // Pasting something copied out of a ProseMirror editor preserves whitespace
  // verbatim, so newlines between the clipboard HTML's block tags would land as
  // a paragraph of spaces. Unconditional: it's a correctness fix for our own
  // copy/paste, not a feature.
  crepe.editor.use(stripPastedInterBlockWhitespace);

  crepe.editor.use(collab);

  // In-document find & replace. Registered unconditionally — it only does
  // work once the host feeds it a query via the bridge — and before the
  // listener so its decorations are in place for the first paint.
  for (const p of markdownSearchPlugins(opts.searchBridge)) {
    crepe.editor.use(p);
  }

  // The listener plugin gives EditorToolbar a single hook to refresh
  // its mark-active state (Bold/Italic icons) on every transaction —
  // selectionUpdated and updated cover cursor moves, typing, remote
  // collab edits, etc. Without it the toolbar would have to install
  // its own prose plugin, which Crepe doesn't allow post-create.
  crepe.editor.use(listener);

  // Local plugins from $lib/editor/plugins, each gated by its own
  // setting. Skipped entirely (not just no-op'd) when off so we don't
  // run their handlers on every keystroke.
  //
  // Order between these two doesn't matter: wikilink detects opens in
  // `apply()` based on cursor position rather than intercepting input,
  // so auto-pair's handleTextInput return-true doesn't shadow it.
  if (opts.wikilinksEnabled && opts.wikilinkBridge) {
    // wikilinkPlugins returns [trigger, decoration] — the trigger
    // owns the menu open/close state and key handling; the decoration
    // runs independently to style existing links as clickable.
    for (const p of wikilinkPlugins(opts.wikilinkBridge, {
      openOnClick: opts.wikilinkOpenOnClick
    })) {
      crepe.editor.use(p);
    }
  }
  // User mentions — same pattern as wikilinks: a trigger plugin owns the menu,
  // the decoration plugin styles committed mentions (and the "self" one).
  if (opts.userMentionsEnabled && opts.userMentionBridge) {
    for (const p of userMentionPlugins(opts.userMentionBridge, {
      currentUsername: opts.currentUsername
    })) {
      crepe.editor.use(p);
    }
  }
  if (opts.autoPairEnabled) crepe.editor.use(autoPair);

  return crepe;
}
