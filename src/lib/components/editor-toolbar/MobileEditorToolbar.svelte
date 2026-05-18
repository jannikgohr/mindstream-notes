<script lang="ts">
  /**
   * Mobile floating formatting toolbar — a centered pill-shaped control
   * that hovers above the soft keyboard, or above the safe-area at the
   * bottom of the page when no keyboard is shown.
   *
   * Positioning: we read `window.visualViewport.height` and subtract it
   * from `window.innerHeight` to find the keyboard's height, then offset
   * the bar by that much from the page bottom. Combined with a small
   * gap and an env(safe-area-inset-bottom) fallback for devices with a
   * home indicator, this keeps the control reachable without ever sitting
   * under the keyboard.
   *
   * Layout: a full-width centering wrapper with horizontal padding caps
   * the pill at the viewport width; the EditorToolbar inside it owns
   * overflow handling, so a too-narrow phone naturally collapses excess
   * buttons into the "More" popover.
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
  Outer: full-width fixed strip used purely to center the pill and to
  contribute the safe-area inset so the pill doesn't get pushed under
  the home indicator on iOS/Android. Pointer-events pass-through so the
  empty area on either side of the pill stays tappable for the editor
  underneath; the pill itself opts back in.
-->
<div
  class="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-3"
  style="bottom: calc({bottomOffset + FLOAT_GAP_PX}px + env(safe-area-inset-bottom, 0px));"
>
  <div
    bind:this={host}
    class="pointer-events-auto inline-flex max-w-full rounded-full border border-border bg-popover/95 shadow-lg backdrop-blur"
  >
    <EditorToolbar {crepe} menuPlacement="top" />
  </div>
</div>
