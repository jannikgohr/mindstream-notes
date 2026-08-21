<script lang="ts">
  /**
   * Stand-in for a `@jis3r/icons` glyph in CuedIcon's unit test.
   *
   * The real icons can't be rendered under vitest — vite-plugin-svelte's
   * CSS preprocessing chokes on the package's components — and they're
   * e2e territory anyway. This double reproduces the only two things
   * CuedIcon interacts with: the `animate` prop and the `size` /
   * `class` pass-through.
   */
  let { size = 24, animate = false, class: className = '' } = $props();
</script>

<div
  class={className}
  data-testid="probe-icon"
  data-size={size}
  data-animate={animate}
  role="img"
  aria-label="probe"
></div>
