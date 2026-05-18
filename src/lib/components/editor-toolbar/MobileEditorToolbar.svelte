<script lang="ts">
  /**
   * Mobile keyboard-aware wrapper for the shared EditorToolbar.
   *
   * Sits in a fixed-position container at the bottom of the visual viewport.
   * When the soft keyboard opens it shrinks `window.visualViewport.height`;
   * we subtract that delta from `window.innerHeight` to find the keyboard's
   * height and lift the bar above it. When no keyboard is visible the delta
   * is 0 and we sit at the page's bottom edge.
   *
   * Sets `--mobile-toolbar-height` on documentElement so the editor's
   * scroll padding can reserve room for the bar — otherwise the caret could
   * end up tucked behind it on the last line of a note.
   */

  import { onDestroy, onMount } from 'svelte';
  import type { Crepe } from '@milkdown/crepe';
  import EditorToolbar from './EditorToolbar.svelte';

  interface Props {
    crepe: Crepe | null;
  }
  let { crepe }: Props = $props();

  let bottomOffset = $state(0);
  let host: HTMLDivElement | null = $state(null);

  function syncOffset() {
    const vv = window.visualViewport;
    if (!vv) {
      bottomOffset = 0;
      return;
    }
    // Keyboard height = layoutViewport.height − visualViewport.height.
    // vv.offsetTop is non-zero on some Android browsers that scroll the
    // layout viewport when the keyboard opens; subtracting it keeps us
    // glued to the visual viewport's bottom edge in either case.
    bottomOffset = Math.max(
      0,
      window.innerHeight - vv.height - vv.offsetTop
    );
  }

  function publishHeight() {
    if (!host) return;
    document.documentElement.style.setProperty(
      '--mobile-toolbar-height',
      `${host.offsetHeight}px`
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

<div
  bind:this={host}
  class="fixed left-0 right-0 z-30 border-t border-border bg-background"
  style="bottom: {bottomOffset}px;"
>
  <EditorToolbar {crepe} menuPlacement="top" />
</div>
