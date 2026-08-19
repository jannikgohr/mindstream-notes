<script lang="ts">
  /**
   * Renders a plugin-provided SVG icon as a themed monochrome glyph.
   *
   * The SVG is applied as a CSS `mask-image` over a `currentColor` background —
   * so it inherits the surrounding text colour (light/dark, hover states) and
   * matches the built-in Lucide icons, and no script inside the SVG can execute
   * (a mask is not a document). Sizing comes from the caller's `class`
   * (e.g. `size-3.5`), like the built-in icons.
   */
  import { loadPluginIcon, svgMaskValue } from './plugin-assets';

  interface Props {
    pluginId: string;
    /** Plugin-relative `.svg` path (from the manifest). */
    file: string;
    class?: string;
  }
  let { pluginId, file, class: klass = '' }: Props = $props();

  let mask = $state<string | null>(null);

  $effect(() => {
    let cancelled = false;
    const id = pluginId;
    const f = file;
    void loadPluginIcon(id, f).then((svg) => {
      if (!cancelled) mask = svg ? svgMaskValue(svg) : null;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

<span
  class="inline-block shrink-0 bg-current {klass}"
  class:scale-[0.45]={!mask}
  class:rounded-sm={!mask}
  class:opacity-70={!mask}
  aria-hidden="true"
  data-loaded={mask ? 'true' : 'false'}
  style={mask
    ? `-webkit-mask-image: ${mask}; mask-image: ${mask}; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-position: center; mask-position: center; -webkit-mask-size: contain; mask-size: contain;`
    : undefined}
></span>
