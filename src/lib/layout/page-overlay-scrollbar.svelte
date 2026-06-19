<script lang="ts">
  /**
   * Floating overlay scrollbar for a vertically-scrolling page container.
   *
   * The container hides its native scrollbar (so the bar never steals
   * width and the page stays centred — see PAGE_SCROLLER_SCROLLBAR_CLASS).
   * This draws a thin thumb *over* the container's right edge that mirrors
   * the scroll position and can be dragged. It stays hidden until the
   * pointer nears the right edge (the scrollbar area), is dragged, or the
   * container was just scrolled — then it fades in, so it never disturbs
   * the centred layout.
   *
   * Purely presentational (aria-hidden): native wheel / trackpad / drag
   * and keyboard scrolling stay available. Must be placed inside a
   * `position: relative` wrapper around `target`.
   */
  import { onDestroy, onMount } from 'svelte';
  import { cn } from '$lib/utils';

  type Props = {
    /** The scrollable container element (bind its `ref`). */
    target: HTMLElement | null;
    class?: string;
  };

  let { target, class: className }: Props = $props();

  // Distance (px) from the right edge that counts as "over the scrollbar".
  const EDGE_ZONE = 24;
  // How long the bar lingers after scrolling stops.
  const SCROLL_LINGER_MS = 900;
  // Smallest grabbable thumb, as a % of the track.
  const MIN_THUMB_PCT = 8;

  let overflow = $state(false);
  let thumbHeightPct = $state(0);
  let thumbTopPct = $state(0);
  let nearEdge = $state(false);
  let thumbHover = $state(false);
  let dragging = $state(false);
  let scrolling = $state(false);
  const visible = $derived(nearEdge || thumbHover || dragging || scrolling);

  let dragStartY = 0;
  let dragStartScroll = 0;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;

  function update() {
    const el = target;
    if (!el) {
      overflow = false;
      return;
    }
    const max = el.scrollHeight - el.clientHeight;
    overflow = max > 1;
    if (!overflow) return;
    thumbHeightPct = Math.max(
      (el.clientHeight / el.scrollHeight) * 100,
      MIN_THUMB_PCT
    );
    thumbTopPct = (el.scrollTop / max) * (100 - thumbHeightPct);
  }

  function onScroll() {
    update();
    scrolling = true;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => (scrolling = false), SCROLL_LINGER_MS);
  }

  function onMouseMove(event: MouseEvent) {
    const el = target;
    if (!el) return;
    nearEdge = el.getBoundingClientRect().right - event.clientX <= EDGE_ZONE;
  }

  function onMouseLeave() {
    nearEdge = false;
  }

  function observe() {
    resizeObserver?.disconnect();
    const el = target;
    if (!el) return;
    resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(el);
    update();
  }

  $effect(() => {
    const el = target;
    observe();
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('mouseleave', onMouseLeave);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('mouseleave', onMouseLeave);
    };
  });

  onMount(() => {
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    if (scrollTimer) clearTimeout(scrollTimer);
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
  });

  function onPointerDown(event: PointerEvent) {
    const el = target;
    if (!el) return;
    dragging = true;
    dragStartY = event.clientY;
    dragStartScroll = el.scrollTop;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging) return;
    const el = target;
    if (!el) return;
    // Map thumb travel back to scroll distance by the track:content ratio.
    const delta = event.clientY - dragStartY;
    el.scrollTop =
      dragStartScroll + delta * (el.scrollHeight / el.clientHeight);
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }
</script>

{#if overflow}
  <div
    class={cn(
      'pointer-events-none absolute inset-y-0 right-0 z-20 w-3',
      className
    )}
    aria-hidden="true"
  >
    <!-- Presentational: the wrapper is aria-hidden, so no label is needed. -->
    <!-- svelte-ignore a11y_consider_explicit_label -->
    <button
      type="button"
      tabindex="-1"
      class="absolute right-0.5 w-1.5 touch-none rounded-full bg-foreground/30 transition-opacity duration-150 hover:bg-foreground/50 {visible
        ? 'pointer-events-auto opacity-100'
        : 'pointer-events-none opacity-0'}"
      style="height: {thumbHeightPct}%; top: {thumbTopPct}%;"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onmouseenter={() => (thumbHover = true)}
      onmouseleave={() => {
        thumbHover = false;
        nearEdge = false;
      }}
    ></button>
  </div>
{/if}
