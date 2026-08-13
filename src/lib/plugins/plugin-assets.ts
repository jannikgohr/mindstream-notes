/**
 * Plugin-provided SVG icons.
 *
 * A plugin ships its icon as a bundled `.svg` file (referenced from the
 * manifest). We render it **safely as a CSS mask** — never inline `{@html}` and
 * never a script-capable context — so a hostile SVG can't execute anything, and
 * the glyph inherits the host's `currentColor` (themes light/dark, matches the
 * built-in icons). See `PluginIcon.svelte`.
 */

import { readPluginFile } from './plugin-files';

/** Reject implausibly large icons before turning them into a data URI. */
const MAX_ICON_BYTES = 64 * 1024;

/**
 * Load a plugin's bundled SVG icon, or `null` when it's missing, too large, or
 * doesn't look like an SVG. Pure data — the caller decides how to render (as a
 * mask, via {@link svgMaskValue}).
 */
export async function loadPluginIcon(
  pluginId: string,
  file: string
): Promise<string | null> {
  const svg = await readPluginFile(pluginId, file);
  if (svg === null || svg.length > MAX_ICON_BYTES) return null;
  // Must actually be an `<svg …>` root; anything else can't be a valid mask and
  // is more likely a mistake or an attempt to slip in other content.
  if (!/<svg[\s>]/i.test(svg)) return null;
  return svg;
}

/**
 * A `mask-image` CSS value from raw SVG: a URL-encoded `data:` URI. Used as a
 * mask (not `<img>`/`{@html}`), so no script in the SVG can run.
 */
export function svgMaskValue(svg: string): string {
  const encoded = encodeURIComponent(svg)
    .replace(/'/g, '%27')
    .replace(/"/g, '%22');
  return `url("data:image/svg+xml,${encoded}")`;
}
