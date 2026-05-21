/**
 * Mermaid diagram rendering for Crepe code-fences.
 *
 * Not a Milkdown `$prose` plugin — Crepe doesn't ship Mermaid support
 * directly, but it does let us hook the CodeMirror feature's
 * `renderPreview` callback to swap a `mermaid` fence's raw text for a
 * rendered SVG below the editor. This file owns that callback and the
 * one-time Mermaid initialisation.
 *
 * Approach (per Milkdown discussion #1479):
 *   1. Return a placeholder element synchronously so Crepe has a node
 *      to mount immediately.
 *   2. Render the diagram with `mermaid.render(...)`.
 *   3. Hand the rendered SVG to `applyPreview` as a base64 data-URL
 *      `<img>` — NOT as raw innerHTML. Crepe's preview container has
 *      historically failed to render text/foreignObject inside an
 *      injected SVG, but an `<img>` source-of-truth bypasses that
 *      entirely (last working snippet in the thread, March 2026).
 *
 * Mermaid is heavyweight (~1 MB). We dynamic-import it the first time
 * a diagram is requested so the main editor bundle stays slim — notes
 * that don't use Mermaid never pay for it.
 */

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
        const message = err instanceof Error ? err.message : String(err);
        const errEl = document.createElement('div');
        errEl.className = 'mermaid-preview-error';
        errEl.textContent = message;
        applyPreview(errEl);
      }
    })
    .catch((err) => {
      console.error('[mermaid] dynamic import failed', err);
      const errEl = document.createElement('div');
      errEl.className = 'mermaid-preview-error';
      errEl.textContent = 'Failed to load Mermaid';
      applyPreview(errEl);
    });

  return placeholder;
}
