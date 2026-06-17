<script lang="ts">
  import { onDestroy, onMount, tick, type Snippet } from 'svelte';
  import { cn } from '$lib/utils';

  type Props = {
    expanded: Snippet;
    collapsed: Snippet;
    class?: string;
    margin?: number;
  };

  let { expanded, collapsed, class: className, margin = 2 }: Props = $props();

  let slotEl = $state<HTMLDivElement | null>(null);
  let expandedMeasureEl = $state<HTMLDivElement | null>(null);
  let collapsedActive = $state(false);
  let frame: number | null = null;
  let resizeObserver: ResizeObserver | null = null;

  function toolbarContentWidth(toolbar: HTMLElement): number {
    const style = getComputedStyle(toolbar);
    return (
      toolbar.clientWidth -
      parseFloat(style.paddingLeft || '0') -
      parseFloat(style.paddingRight || '0')
    );
  }

  function scheduleMeasure() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      measure();
    });
  }

  function measure() {
    if (!slotEl || !expandedMeasureEl) return;
    const row = slotEl.parentElement;
    const toolbar = slotEl.closest<HTMLElement>('[role="toolbar"]');
    if (!row || !toolbar) return;

    const available = toolbarContentWidth(toolbar);
    const currentWidth = slotEl.offsetWidth;
    const expandedWidth = expandedMeasureEl.offsetWidth;
    const expandedRequiredWidth =
      row.scrollWidth - currentWidth + expandedWidth;
    const nextCollapsed = expandedRequiredWidth > available - margin;

    if (nextCollapsed !== collapsedActive) {
      collapsedActive = nextCollapsed;
      void tick().then(scheduleMeasure);
    }
  }

  function observeLayout() {
    resizeObserver?.disconnect();
    if (!slotEl || !expandedMeasureEl) return;
    const row = slotEl.parentElement;
    const toolbar = slotEl.closest<HTMLElement>('[role="toolbar"]');
    resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(slotEl);
    resizeObserver.observe(expandedMeasureEl);
    if (row) resizeObserver.observe(row);
    if (toolbar) resizeObserver.observe(toolbar);
    scheduleMeasure();
  }

  onMount(() => {
    observeLayout();
    window.addEventListener('resize', scheduleMeasure);
    window.visualViewport?.addEventListener('resize', scheduleMeasure);
  });

  $effect(() => {
    void slotEl;
    void expandedMeasureEl;
    observeLayout();
  });

  $effect(() => {
    void collapsedActive;
    scheduleMeasure();
  });

  onDestroy(() => {
    if (frame !== null) cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    window.removeEventListener('resize', scheduleMeasure);
    window.visualViewport?.removeEventListener('resize', scheduleMeasure);
  });
</script>

<div bind:this={slotEl} class={cn('flex shrink-0', className)}>
  {#if collapsedActive}
    {@render collapsed()}
  {:else}
    {@render expanded()}
  {/if}
</div>

<div
  bind:this={expandedMeasureEl}
  class="pointer-events-none fixed -left-[10000px] top-0 z-[-1] flex opacity-0"
  aria-hidden="true"
  inert
>
  {@render expanded()}
</div>
