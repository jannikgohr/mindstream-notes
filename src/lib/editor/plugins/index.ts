/**
 * Local Milkdown plugins — small, private prose plugins layered on top of
 * Crepe to add features Crepe doesn't ship with (or where we want
 * notes-app-specific behaviour).
 *
 * Each plugin in this folder should be a `$prose` (or `$useKeymap`,
 * `$inputRule`, …) factory from `@milkdown/kit/utils` so it plugs into
 * `crepe.editor.use(...)` like any other Milkdown plugin. Keep them
 * self-contained — no Svelte stores, no app-state imports — so they can
 * be unit-tested against a bare ProseMirror view and re-used by the
 * mobile / freeform shells too.
 *
 * Registration happens in `$lib/editor/crepe-setup.ts` so each setting
 * gates its plugin in one place rather than scattering the toggles
 * across feature files.
 */

export { autoPair } from './auto-pair';
export { installBlockHandleGuard } from './block-handle-guard';
export { installSelectionToolbarAutoHide } from './selection-toolbar';
export {
  addMermaidMenuItem,
  mermaidLanguageDescription,
  renderMermaidPreview
} from './mermaid';
export {
  createWikilinkBridge,
  resolveNoteIdByTitle,
  wikilinkPlugins,
  type WikilinkBridge
} from './wikilink';
export {
  createMarkdownSearchBridge,
  markdownSearchPlugins,
  type MarkdownSearchBridge,
  type MarkdownSearchOptions
} from './markdown-search';
