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

import { Crepe, CrepeFeature } from '@milkdown/crepe';
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
  mermaidLanguageDescription,
  renderMermaidPreview,
  wikilinkPlugins,
  type WikilinkBridge
} from './plugins';

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
  wikilinkBridge: WikilinkBridge | null;
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

  crepe.editor.use(collab);
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
    for (const p of wikilinkPlugins(opts.wikilinkBridge)) {
      crepe.editor.use(p);
    }
  }
  if (opts.autoPairEnabled) crepe.editor.use(autoPair);

  return crepe;
}
