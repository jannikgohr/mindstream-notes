<script lang="ts">
  /**
   * Mobile floating formatting toolbar — a centered pill that hovers above
   * the soft keyboard, or above the safe-area at the bottom of the page
   * when no keyboard is shown.
   *
   * Positioning: read `window.visualViewport.height` and subtract it from
   * `window.innerHeight` to find the keyboard's height, then offset the
   * bar by that much from the page bottom. Plus env(safe-area-inset-bottom)
   * for the home-indicator gap on iOS/Android.
   *
   * Sizing: the EditorToolbar runs in `fitContent` mode and sets its own
   * width via inline style to `min(naturalContent, 100%)`. The chrome
   * (rounded-full border, shadow, bg) lives on the EditorToolbar's outer
   * element via the class prop so the pill wraps tightly around the
   * actual button row. A thin `max-w-full` wrapper exists only to (a) be
   * the bind:this target for height measurement and (b) constrain the
   * EditorToolbar's `max-width: 100%` percentage to the centering strip's
   * content area (viewport − horizontal padding).
   *
   * Sets `--mobile-toolbar-height` on documentElement so the editor's
   * bottom padding can reserve room — otherwise the caret could end up
   * tucked behind the floating pill on the last line of a note.
   */

  import { onDestroy, onMount } from 'svelte';
  import type { Crepe } from '@milkdown/crepe';
  import EditorToolbar from './EditorToolbar.svelte';

  interface Props {
    crepe: Crepe | null;
  }
  let { crepe }: Props = $props();

  /** Gap between the pill and the keyboard (or screen edge). */
  const FLOAT_GAP_PX = 12;

  let bottomOffset = $state(0);
  let host: HTMLDivElement | null = $state(null);

  function syncOffset() {
    const vv = window.visualViewport;
    if (!vv) {
      bottomOffset = 0;
      return;
    }
    // Keyboard height = layoutViewport.height − visualViewport.height.
    // vv.offsetTop covers Android variants that scroll the layout viewport
    // instead of resizing the visual one.
    bottomOffset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  }

  function publishHeight() {
    if (!host) return;
    // Include the gap so editor padding accounts for the floating offset,
    // not just the pill itself.
    document.documentElement.style.setProperty(
      '--mobile-toolbar-height',
      `${host.offsetHeight + FLOAT_GAP_PX}px`
    );
  }

  onMount(() => {
    syncOffset();
    publishHeight();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', syncOffset);
    vv?.addEventListener('scroll', syncOffset);
    window.addEventListener('resize', syncOffset);

    const ro = host ? new ResizeObserver(publishHeight) : null;
    if (host && ro) ro.observe(host);

    return () => {
      vv?.removeEventListener('resize', syncOffset);
      vv?.removeEventListener('scroll', syncOffset);
      window.removeEventListener('resize', syncOffset);
      ro?.disconnect();
    };
  });

  onDestroy(() => {
    document.documentElement.style.removeProperty('--mobile-toolbar-height');
  });
</script>

<!--
  Outer strip: full-width fixed band purely for centering. Pointer-events
  pass-through so the empty space on either side of the pill stays tappable
  for the editor underneath; the pill itself opts back in via the chrome
  class on EditorToolbar.
-->
<div
  class="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-3"
  style="bottom: calc({bottomOffset +
    FLOAT_GAP_PX}px + env(safe-area-inset-bottom, 0px));"
>
  <div bind:this={host} class="max-w-full">
    <EditorToolbar
      {crepe}
      menuPlacement="top"
      fitContent
      class="pointer-events-auto overflow-hidden rounded-full border border-border bg-popover/95 shadow-lg backdrop-blur"
    />
  </div>
</div>
