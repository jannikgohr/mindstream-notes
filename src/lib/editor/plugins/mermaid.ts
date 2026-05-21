/**
 * Mermaid diagram support for Crepe.
 *
 * Two pieces of plumbing, kept together so adding/removing Mermaid is a
 * single-file edit:
 *
 *   1. `renderMermaidPreview` — passed to Crepe's CodeMirror feature
 *      config as `renderPreview`. When the user creates a fence whose
 *      language is `mermaid`, Crepe calls this with the code body; we
 *      render the diagram below the editable code (per Milkdown
 *      discussion #1479's final pattern: hand the SVG to `applyPreview`
 *      as a base64 data-URL `<img>`, which sidesteps the text/foreign-
 *      object rendering issues that plagued direct innerHTML injection).
 *
 *   2. `addMermaidMenuItem` — extends Crepe's slash menu with a
 *      "Mermaid diagram" item under the existing Advanced group, so
 *      users can discover the feature without knowing the `mermaid`
 *      language string. Mirrors how Crepe's built-in Math item inserts
 *      a code block pre-set to `language: 'LaTeX'`.
 *
 * Mermaid is ~1 MB. We dynamic-import it on the first render so notes
 * that never open a diagram pay nothing for it; the import promise is
 * cached so concurrent renders dedupe.
 */

import type { Ctx } from '@milkdown/kit/ctx';
import { commandsCtx } from '@milkdown/kit/core';
import {
  addBlockTypeCommand,
  clearTextInCurrentBlockCommand,
  codeBlockSchema
} from '@milkdown/kit/preset/commonmark';
import { systemPrefersMode, userPrefersMode } from 'mode-watcher';
import { get } from 'svelte/store';

/** Crepe's renderPreview applyPreview callback. */
type ApplyPreview = (value: null | string | HTMLElement) => void;

/**
 * Lazily-loaded singleton — Mermaid's `initialize()` registers the
 * theme/securityLevel/etc. globally, so we should only do it once per
 * page. The Promise also dedupes concurrent renders that happen before
 * the first import resolves.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import('mermaid').then((mod) => {
    const mermaid = mod.default;
    // Read the active theme once at init time. Mermaid doesn't pick up
    // theme changes for diagrams already rendered, so we'd need to
    // re-render on theme flip to refresh — for now, the theme at first
    // diagram render wins. Acceptable for a notes app where switching
    // themes mid-edit is rare.
    mermaid.initialize({
      startOnLoad: false,
      // 'strict' blocks raw HTML / click handlers — fine for our usage
      // and the safer default for user-authored content.
      securityLevel: 'strict',
      theme: resolveTheme(),
      // Force deterministic IDs out of the way of any other library
      // that touches the DOM with id="mermaid-..." style selectors.
      // Combined with our unique-per-render id we get no collisions.
      deterministicIds: false
    });
    return mermaid;
  });
  return mermaidPromise;
}

function resolveTheme(): 'default' | 'dark' {
  // Prefer mode-watcher's resolved values so we agree with the rest of
  // the UI; fall back to document class (SSR-safe). When SSR'd there's
  // no document and no localStorage, so default to 'default'.
  if (typeof document === 'undefined') return 'default';
  const pref = get(userPrefersMode);
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'default';
  // 'system' → check OS preference
  const sys = get(systemPrefersMode);
  if (sys === 'dark') return 'dark';
  if (sys === 'light') return 'default';
  // Last-resort: read the dark class Tailwind toggles via mode-watcher.
  return document.documentElement.classList.contains('dark') ? 'dark' : 'default';
}

/**
 * Counter for unique render ids. Mermaid uses the id we pass to
 * `render()` as the resulting <svg id>; reusing it across diagrams
 * makes Mermaid throw "Element with id … already exists". A per-call
 * suffix from a process-local counter is enough — we don't need a
 * UUID here.
 */
let nextRenderId = 0;
function makeRenderId(): string {
  nextRenderId = (nextRenderId + 1) | 0;
  return `mindstream-mermaid-${nextRenderId}`;
}

/**
 * Encode an SVG string into a `data:image/svg+xml;base64,...` URL.
 * The byte-by-byte `String.fromCharCode` loop avoids the spread-on-large-
 * array stack-overflow that `String.fromCodePoint(...bytes)` would
 * trigger for big diagrams.
 */
function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:image/svg+xml;charset=utf-8;base64,' + btoa(bin);
}

function applyMermaidError(applyPreview: ApplyPreview, message: string) {
  const errEl = document.createElement('div');
  errEl.className = 'mermaid-preview-error';
  errEl.textContent = message;
  applyPreview(errEl);
}

/**
 * Crepe `renderPreview` hook for Mermaid. Return `null` for any other
 * language so Crepe falls through to its default handling. Drop into
 * `featureConfigs[Crepe.Feature.CodeMirror].renderPreview` (see
 * `$lib/editor/crepe-setup.ts`).
 */
export function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: ApplyPreview
): null | HTMLElement {
  if (language !== 'mermaid') return null;
  // Empty fence → no point bothering Mermaid (and avoids the "No
  // diagram type detected" error every keystroke while the user is
  // still typing the first line).
  if (!content.trim()) return null;

  const placeholder = document.createElement('div');
  placeholder.className = 'mermaid-preview';

  void loadMermaid()
    .then(async (mermaid) => {
      try {
        const { svg } = await mermaid.render(makeRenderId(), content);
        const img = new Image();
        img.src = svgToDataUrl(svg);
        img.alt = 'Mermaid diagram';
        img.className = 'mermaid-preview-img';
        applyPreview(img);
      } catch (err) {
        applyMermaidError(
          applyPreview,
          err instanceof Error ? err.message : String(err)
        );
      }
    })
    .catch((err) => {
      console.error('[mermaid] dynamic import failed', err);
      applyMermaidError(applyPreview, 'Failed to load Mermaid');
    });

  return placeholder;
}

/* --- Slash-menu integration ------------------------------------------------- */

/**
 * Subset of Crepe's `GroupBuilder` that we actually use. Typed
 * structurally rather than imported so we don't reach into Crepe's
 * private subpaths — the call site in `crepe-setup.ts` passes the
 * fully-typed builder Crepe hands to `buildMenu`, and TS validates the
 * shape against this interface.
 */
interface MenuItemSpec {
  label: string;
  icon: string;
  onRun: (ctx: Ctx) => void;
}
interface MenuGroup {
  addItem(key: string, item: MenuItemSpec): unknown;
}
export interface SlashMenuBuilder {
  getGroup(key: string): MenuGroup;
  addGroup(key: string, label: string): MenuGroup;
}

// Lucide-style "workflow" glyph. Crepe accepts icon strings (innerHTML)
// so SVG markup drops in directly alongside the rest of its menu items.
const mermaidIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>`;

/**
 * Add a "Mermaid diagram" item to the Advanced group of Crepe's slash
 * menu. Inserting a code block pre-set to `language: 'mermaid'` is what
 * routes the fence through `renderMermaidPreview` below the code.
 *
 * Crepe's default config always provides an 'advanced' group (alongside
 * Code, Image, Table, Math), so `getGroup` is the normal path. The
 * fallback `addGroup` is paranoia for the case where a future config
 * sets `advancedGroup: null`.
 */
export function addMermaidMenuItem(builder: SlashMenuBuilder, label: string) {
  let group: MenuGroup;
  try {
    group = builder.getGroup('advanced');
  } catch {
    group = builder.addGroup('advanced', 'Advanced');
  }
  group.addItem('mermaid', {
    label,
    icon: mermaidIcon,
    onRun: (ctx) => {
      const commands = ctx.get(commandsCtx);
      const codeBlock = codeBlockSchema.type(ctx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(addBlockTypeCommand.key, {
        nodeType: codeBlock,
        attrs: { language: 'mermaid' }
      });
    }
  });
}
