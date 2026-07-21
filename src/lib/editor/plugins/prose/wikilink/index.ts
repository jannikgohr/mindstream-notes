/**
 * Wikilinks — Obsidian-style `[[Note Title]]` editing affordances backed by
 * standard markdown links: `[Note Title](mindstream://note/<id>)`.
 *
 * Three concerns in one file because they share state and the surface
 * area is small:
 *
 *   1. **Trigger plugin** — detects `[[` typed at the cursor, opens a
 *      menu via the per-editor `WikilinkBridge`, tracks the query
 *      span (text between `[[` and the cursor), and intercepts
 *      Arrow / Enter / Esc while open. Auto-pair brackets and the
 *      plain `[[` case both reach the same trigger because we only
 *      look at what's in the doc, not what the user typed.
 *
 *   2. **Decoration plugin** — decorates ID-backed note links so they read
 *      like `[[Title]]` in the editor. Legacy literal `[[Title]]` spans are
 *      still styled and clickable as a compatibility fallback.
 *
 *   3. **Click handler** — plain click (when enabled in settings) or
 *      Cmd/Ctrl+click on a `.wikilink` opens by stable note ID when present,
 *      falling back to title resolution only for legacy literal wikilinks.
 *      When plain click is disabled, click is left to ProseMirror.
 *
 * The trigger plugin and the popup component share a `WikilinkBridge`
 * object that NoteEditor creates per editor instance. The bridge is how
 * the plugin says "menu just opened with this query" and the popup says
 * "user picked this title" without either side reaching into the other's
 * implementation. Per-editor (not module-level) so two open notes don't
 * fight over a single popup.
 */

import { $prose } from '@milkdown/kit/utils';
import type { WikilinkBridge } from '../../wikilink-bridge.svelte';
import { wikilinkTriggerPlugin } from './trigger';
import {
  wikilinkDecorationPlugin,
  type WikilinkPluginOptions
} from './decoration';

// Re-export so consumers can still get everything wikilink-related
// through this one module — the bridge factory lives in its own
// .svelte.ts because Svelte's compiler treats the `$` prefix as
// reserved in .svelte.ts files, which would block this file's
// `import { $prose } from '@milkdown/kit/utils'`.
export type { WikilinkBridge } from '../../wikilink-bridge.svelte';
export { createWikilinkBridge } from '../../wikilink-bridge.svelte';

/* --- Note link resolution -------------------------------------------------- */

// The href format itself is shared with the source-mode plugin (and the
// render-time neutralizer), so it lives at the plugins root. Re-exported
// here so wikilink consumers can still reach everything through this module.
export { noteHref, parseNoteHref } from '../../wikilink-href';

export { resolveNoteIdByTitle } from './note-resolve';
export {
  wikilinkDecorationPlugin,
  type WikilinkPluginOptions
} from './decoration';

/**
 * Two `$prose` plugins wrapped as one Milkdown plugin array. Crepe's
 * `.use(...)` accepts arrays so this drops in the same way as our
 * other local plugins (see `crepe-setup.ts`).
 *
 * The decoration + click handler runs unconditionally once enabled —
 * even when the menu isn't open, the doc still has wikilinks the user
 * might want to click. The trigger plugin is the only one that needs
 * the per-editor bridge.
 */
export function wikilinkPlugins(
  bridge: WikilinkBridge,
  options: WikilinkPluginOptions
) {
  return [
    $prose(() => wikilinkTriggerPlugin(bridge)),
    $prose(() => wikilinkDecorationPlugin(bridge, options))
  ];
}
