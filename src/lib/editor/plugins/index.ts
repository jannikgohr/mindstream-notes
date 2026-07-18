/**
 * Local editor plugins — small, private extensions layered on top of the
 * editors this app ships, adding features they don't come with (or where
 * we want notes-app-specific behaviour).
 *
 * The app has TWO editing surfaces over the same document, and a plugin
 * generally has to exist twice — once per surface's extension API:
 *
 *   - `prose/`  — Milkdown/ProseMirror plugins for the WYSIWYG surface.
 *     Each is a `$prose` (or `$useKeymap`, `$inputRule`, …) factory from
 *     `@milkdown/kit/utils` so it plugs into `crepe.editor.use(...)` like
 *     any other Milkdown plugin.
 *   - `source/` — CodeMirror 6 extensions for the raw-markdown surface.
 *     Each exports an `Extension` (or a factory returning one) so it drops
 *     into the source editor's extension list.
 *
 * Features spanning both surfaces (wikilinks, user mentions) keep their
 * shared, surface-agnostic pieces HERE at the root — currently the
 * bridges, which carry the autocomplete-menu state the popup components
 * read. Neither surface's plugin knows the other exists; they meet only
 * through the bridge contract, and the host creates one bridge per
 * surface so the two panes can't fight over a single popup in Split mode.
 *
 * Keep the plugins self-contained — no Svelte stores, no app-state
 * imports — so they can be unit-tested against a bare ProseMirror view /
 * CodeMirror state and re-used by the mobile / freeform shells too.
 *
 * Registration happens in `$lib/editor/crepe-setup.ts` (prose) and
 * `$lib/editor/source/SourceEditor.svelte` (source), so each setting
 * gates its plugin on both surfaces in one place per surface rather than
 * scattering the toggles across feature files.
 */

/* --- Shared (surface-agnostic) -------------------------------------------- */

export {
  createWikilinkBridge,
  type CaretRect,
  type WikilinkBridge
} from './wikilink-bridge.svelte';
export {
  createUserMentionBridge,
  type MentionUser,
  type UserMentionBridge
} from './user-mention-bridge.svelte';
export { noteHref, parseNoteHref } from './wikilink-href';
export { parseUserHref, userHref } from './user-mention-href';

/* --- WYSIWYG (Milkdown / ProseMirror) ------------------------------------- */

export { autoPair } from './prose/auto-pair';
export { isEmptyParagraph, preserveBlankLines } from './prose/blank-lines';
export { installBlockHandleGuard } from './prose/block-handle-guard';
export { installSelectionToolbarAutoHide } from './prose/selection-toolbar';
export {
  addMermaidMenuItem,
  mermaidLanguageDescription,
  renderMermaidPreview
} from './prose/mermaid';
export { resolveNoteIdByTitle, wikilinkPlugins } from './prose/wikilink';
export {
  refreshMentionDecorations,
  userMentionPlugins,
  type UserMentionPluginOptions
} from './prose/user-mention';
export {
  createMarkdownSearchBridge,
  markdownSearchPlugins,
  type MarkdownSearchBridge,
  type MarkdownSearchOptions
} from './prose/markdown-search';

/* --- Source (CodeMirror) --------------------------------------------------- */

export { sourceAutoPair } from './source/auto-pair';
export { sourceWikilink } from './source/wikilink';
export { sourceUserMention } from './source/user-mention';
